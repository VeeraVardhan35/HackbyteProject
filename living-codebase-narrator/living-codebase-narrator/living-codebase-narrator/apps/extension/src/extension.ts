import * as vscode from 'vscode';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { nanoid } from 'nanoid';

type Snapshot = {
  text: string;
  version: number;
};

type Pending = {
  timer: NodeJS.Timeout;
  latest: {
    uri: vscode.Uri;
    languageId: string;
    filePath: string;
    diff: string;
    context: string;
    changedLines: number;
  };
};

type GitContext = {
  repo: string;
  branch?: string;
};

const DEFAULT_SESSION_ID = 'local-dev';
const execFileAsync = promisify(execFile);

let output: vscode.OutputChannel | undefined;

function log(msg: string) {
  output?.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('lcn');
  return {
    backendUrl: cfg.get<string>('backendUrl', 'http://localhost:8787'),
    webAppUrl: cfg.get<string>('webAppUrl', ''),
    debounceMs: cfg.get<number>('debounceMs', 5000),
    minChangedLines: cfg.get<number>('minChangedLines', 1),
    ignoreGlobs: cfg.get<string[]>('ignoreGlobs', [])
  };
}

function isIgnored(filePath: string, globs: string[]) {
  return globs.some((g) => minimatch(filePath.replace(/\\/g, '/'), g, { dot: true }));
}

function countChangedLines(unifiedDiff: string) {
  const add = (unifiedDiff.match(/^\+[^+]/gm) ?? []).length;
  const del = (unifiedDiff.match(/^-[-]/gm) ?? []).length;
  return add + del;
}

async function postDelta(payload: unknown, backendUrl: string) {
  const res = await fetch(`${backendUrl.replace(/\/$/, '')}/deltas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as unknown;
}

async function runGit(args: string[], cwd: string) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true
  });
  return stdout.trim();
}

function normalizeRepoName(remoteUrl: string, fallbackPath: string) {
  const cleaned = String(remoteUrl ?? '').trim().replace(/\.git$/i, '');
  if (!cleaned) return path.basename(fallbackPath);
  const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf(':'));
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

async function getGitContext(uri: vscode.Uri): Promise<GitContext> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const cwd = workspaceFolder?.uri.fsPath ?? path.dirname(uri.fsPath);

  try {
    const [repoRoot, remoteUrl, branch] = await Promise.all([
      runGit(['rev-parse', '--show-toplevel'], cwd),
      runGit(['remote', 'get-url', 'origin'], cwd).catch(() => ''),
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => '')
    ]);

    return {
      repo: normalizeRepoName(remoteUrl, repoRoot || cwd),
      branch: branch || undefined
    };
  } catch {
    return {
      repo: workspaceFolder ? path.basename(workspaceFolder.uri.fsPath) : path.basename(path.dirname(uri.fsPath)),
      branch: undefined
    };
  }
}

class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'lcn.sidebar';

  private view: vscode.WebviewView | undefined;
  private lastDocsJson = '[]';
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'openFile' && typeof msg.filePath === 'string') {
        const uri = vscode.Uri.file(msg.filePath);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {
          // ignore
        }
        return;
      }

      if (msg.type === 'vote' && typeof msg.id === 'string' && typeof msg.direction === 'string') {
        const { backendUrl } = getConfig();
        try {
          await fetch(`${backendUrl.replace(/\/$/, '')}/docs/${msg.id}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ direction: msg.direction })
          });
          await this.fetchDocsOnce();
        } catch (error) {
          log(`Vote failed â€” ${String(error)}`);
        }
        return;
      }

      if (msg.type === 'shareRepo') {
        const gitContext = await this.getWorkspaceGitContext();
        if (!gitContext.repo) return;

        const { webAppUrl } = getConfig();
        if (webAppUrl) {
          const shareUrl = new URL(webAppUrl);
          shareUrl.searchParams.set('repo', gitContext.repo);
          await vscode.env.clipboard.writeText(shareUrl.toString());
          void vscode.window.showInformationMessage(`LCN: copied repo share link for ${gitContext.repo}`);
        } else {
          await vscode.env.clipboard.writeText(gitContext.repo);
          void vscode.window.showInformationMessage(`LCN: copied repo name ${gitContext.repo}`);
        }
      }
    });

    void this.fetchDocsOnce();
    this.startPolling();
  }

  public notifyDocFeedChanged(docs: unknown) {
    this.lastDocsJson = JSON.stringify(docs);
    this.view?.webview.postMessage({ type: 'docs', docs });
  }

  private async getWorkspaceGitContext(): Promise<GitContext> {
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceUri) return { repo: '' };
    return getGitContext(workspaceUri);
  }

  private async fetchDocsOnce() {
    const { backendUrl, webAppUrl } = getConfig();
    try {
      const gitContext = await this.getWorkspaceGitContext();
      const docsUrl = new URL(`${backendUrl.replace(/\/$/, '')}/docs`);
      docsUrl.searchParams.set('limit', '25');
      if (gitContext.repo) docsUrl.searchParams.set('repo', gitContext.repo);

      const res = await fetch(docsUrl.toString());
      if (!res.ok) {
        log(`Poll /docs failed: ${res.status}`);
        return;
      }

      const json = (await res.json()) as { docs?: unknown };
      const next = JSON.stringify(json.docs ?? []);
      this.lastDocsJson = next;
      this.view?.webview.postMessage({
        type: 'docs',
        docs: json.docs ?? [],
        repo: gitContext.repo,
        branch: gitContext.branch,
        shareEnabled: Boolean(webAppUrl)
      });
      log(`Poll /docs ok: ${(json.docs as unknown[])?.length ?? 0} docs`);
    } catch (error) {
      log(`Poll /docs error: ${String(error)}`);
    }
  }

  private startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.fetchDocsOnce(), 1500);
    this.ctx.subscriptions.push({ dispose: () => this.pollTimer && clearInterval(this.pollTimer) });
  }

  private renderHtml(webview: vscode.Webview) {
    const nonce = nanoid();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src http: https:`
    ].join('; ');

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root{
      --bg:#0b1220;
      --panel:#121b2e;
      --panel-soft:#0f1728;
      --card:#0b1423;
      --muted:#9fb0c8;
      --text:#eef5ff;
      --line:rgba(180,205,236,.12);
      --line-strong:rgba(180,205,236,.22);
      --accent:#5dd5ff;
      --accent2:#94ffbe;
      --warn:#ffc86c;
      --danger:#ff9191;
      --shadow:0 18px 48px rgba(0,0,0,.28);
      --vscode-font:var(--vscode-font-family, ui-sans-serif);
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:var(--vscode-font);
      background:
        radial-gradient(circle at top left, rgba(93,213,255,.14), transparent 28%),
        linear-gradient(180deg, #0c1422 0%, #09111d 100%);
      color:var(--text);
    }
    button,input{font:inherit}
    .shell{
      min-height:100vh;
      padding:12px;
      display:grid;
      gap:12px;
      align-content:start;
    }
    .panel{
      border:1px solid var(--line);
      border-radius:16px;
      background:linear-gradient(180deg, rgba(255,255,255,.02), transparent), var(--panel);
      box-shadow:var(--shadow);
      overflow:hidden;
    }
    .hero{
      padding:14px;
      display:grid;
      gap:12px;
    }
    .heroTop{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .brand{
      display:grid;
      gap:3px;
    }
    .eyebrow{
      font-size:10px;
      letter-spacing:.18em;
      text-transform:uppercase;
      color:var(--accent);
    }
    .title{
      font-size:15px;
      font-weight:700;
    }
    .subtitle{
      font-size:12px;
      color:var(--muted);
      line-height:1.45;
    }
    .dot{
      width:10px;
      height:10px;
      border-radius:999px;
      background:var(--accent2);
      box-shadow:0 0 0 5px rgba(148,255,190,.12);
      flex:0 0 auto;
    }
    .metaRow,.actionRow,.cardFooter,.voteRow,.panelHead,.repoSummary{
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      align-items:center;
    }
    .chip{
      display:inline-flex;
      align-items:center;
      gap:6px;
      min-height:28px;
      padding:4px 10px;
      border-radius:999px;
      border:1px solid var(--line);
      background:rgba(8,16,28,.66);
      color:var(--muted);
      font-size:11px;
    }
    .chip.ok{color:var(--accent2); border-color:rgba(148,255,190,.24)}
    .chip.warn{color:var(--warn); border-color:rgba(255,200,108,.24)}
    .section{
      padding:12px;
      display:grid;
      gap:10px;
    }
    .panelHead{
      justify-content:space-between;
      align-items:flex-start;
    }
    .panelTitle{
      font-size:11px;
      letter-spacing:.16em;
      text-transform:uppercase;
      color:var(--muted);
    }
    .panelNote{
      font-size:12px;
      color:var(--muted);
      line-height:1.45;
    }
    .actionBtn{
      min-height:34px;
      padding:7px 12px;
      border-radius:10px;
      border:1px solid var(--line-strong);
      background:rgba(10,22,38,.88);
      color:var(--text);
      cursor:pointer;
    }
    .actionBtn:hover{border-color:rgba(93,213,255,.36)}
    .list{
      display:grid;
      gap:8px;
    }
    .fileItem,.card{
      border:1px solid var(--line);
      border-radius:14px;
      background:var(--card);
    }
    .fileItem{
      padding:10px;
      cursor:pointer;
    }
    .fileItem:hover{border-color:rgba(93,213,255,.28); background:rgba(14,24,40,.96)}
    .fileName{
      font-size:12px;
      font-weight:600;
      color:var(--text);
    }
    .filePath{
      margin-top:5px;
      font-size:11px;
      color:var(--muted);
      word-break:break-word;
    }
    .editor{
      padding:12px;
      border-top:1px solid var(--line);
      background:rgba(8,14,24,.72);
    }
    pre{
      margin:0;
      white-space:pre-wrap;
      word-break:break-word;
      font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size:11px;
      line-height:1.55;
      color:#d5e8ff;
    }
    .card{
      padding:12px;
      display:grid;
      gap:8px;
    }
    .cardTop{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:8px;
    }
    .cardTitle{
      font-size:12px;
      font-weight:700;
      word-break:break-word;
    }
    .cardSummary{
      font-size:12px;
      line-height:1.5;
      color:var(--text);
    }
    .tagRow{
      display:flex;
      flex-wrap:wrap;
      gap:6px;
    }
    .tag{
      font-size:10px;
      color:var(--accent);
      border:1px solid rgba(93,213,255,.22);
      border-radius:999px;
      padding:3px 8px;
      background:rgba(93,213,255,.08);
    }
    .voteRow{
      justify-content:space-between;
      border-top:1px solid var(--line);
      padding-top:8px;
    }
    .voteGroup{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
    }
    .voteBtn{
      min-height:30px;
      padding:5px 10px;
      border-radius:8px;
      border:1px solid var(--line);
      background:transparent;
      color:var(--muted);
      cursor:pointer;
      font-size:11px;
    }
    .voteBtn.up{border-color:rgba(148,255,190,.28); color:var(--accent2)}
    .voteBtn.down{border-color:rgba(255,145,145,.28); color:var(--danger)}
    .voteBtn.active{background:rgba(255,255,255,.05)}
    .empty{
      padding:10px;
      color:var(--muted);
      font-size:12px;
      text-align:center;
      border:1px dashed var(--line);
      border-radius:14px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="panel hero">
      <div class="heroTop">
        <div class="brand">
          <div class="eyebrow">Repo narration</div>
          <div class="title">Living Codebase Narrator</div>
          <div class="subtitle">Shared repo memory inside VS Code. Open files, inspect diffs, vote on accuracy, and copy a repo share link for teammates.</div>
        </div>
        <div class="dot" title="live feed"></div>
      </div>
      <div class="metaRow">
        <span class="chip ok" id="repoChip">Repo unknown</span>
        <span class="chip" id="branchChip">Branch --</span>
        <span class="chip" id="docCountChip">0 docs</span>
      </div>
      <div class="actionRow">
        <button class="actionBtn" type="button" id="shareRepoBtn">Share repo feed</button>
        <button class="actionBtn" type="button" id="speakBtn">Speak latest</button>
      </div>
    </section>

    <section class="panel section">
      <div class="panelHead">
        <div>
          <div class="panelTitle">Explorer</div>
          <div class="panelNote">Recent narrated files for this repo. Click one to open it in the editor.</div>
        </div>
      </div>
      <div class="list" id="fileList"></div>
    </section>

    <section class="panel section">
      <div class="panelHead">
        <div>
          <div class="panelTitle">Editor Preview</div>
          <div class="panelNote" id="editorMeta">Waiting for the first generated diff.</div>
        </div>
      </div>
      <div class="editor"><pre id="editorText">// Save a file to generate a diff...</pre></div>
    </section>

    <section class="panel section">
      <div class="panelHead">
        <div>
          <div class="panelTitle">Live Docs</div>
          <div class="panelNote">Shared summaries for teammates in the same GitHub repo. Votes are stored in the backend and refreshed here.</div>
        </div>
      </div>
      <div class="repoSummary">
        <span class="chip" id="statusLeft">ready</span>
        <span class="chip warn" id="statusRight">polling</span>
      </div>
      <div class="list" id="cards"></div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let docs = [];
    let lastSpokenId = null;
    let repoName = '';
    let branchName = '';
    let shareEnabled = false;
    const votes = new Map();

    function escapeHtml(s){return String(s).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));}

    function pathTail(fp){
      const s = String(fp || '');
      const slash = s.lastIndexOf('/');
      const backslash = s.lastIndexOf(String.fromCharCode(92));
      const idx = Math.max(slash, backslash);
      return idx >= 0 ? s.slice(idx + 1) : s;
    }

    function updateMeta(){
      const repoChip = document.getElementById('repoChip');
      const branchChip = document.getElementById('branchChip');
      const docCountChip = document.getElementById('docCountChip');
      const shareRepoBtn = document.getElementById('shareRepoBtn');
      if (repoChip) repoChip.textContent = repoName ? 'Repo ' + repoName : 'Repo unknown';
      if (branchChip) branchChip.textContent = branchName ? 'Branch ' + branchName : 'Branch --';
      if (docCountChip) docCountChip.textContent = String(docs.length) + ' docs';
      if (shareRepoBtn) shareRepoBtn.disabled = !repoName;
    }

    async function sendVote(docId, direction){
      vscode.postMessage({ type: 'vote', id: docId, direction });
      votes.set(docId, direction);
      render();
    }

    function speakLatest(){
      const latest = docs[0];
      if (!latest || !latest.summary || lastSpokenId === latest.id) return;
      if (!('speechSynthesis' in window)) return;
      lastSpokenId = latest.id;
      const utterance = new SpeechSynthesisUtterance(latest.summary);
      utterance.rate = 1;
      utterance.pitch = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    }

    function render(){
      const cards = document.getElementById('cards');
      const fileList = document.getElementById('fileList');
      const editorText = document.getElementById('editorText');
      const editorMeta = document.getElementById('editorMeta');
      const statusLeft = document.getElementById('statusLeft');
      const statusRight = document.getElementById('statusRight');

      updateMeta();

      if (statusLeft) statusLeft.textContent = docs.length ? 'live feed synced' : 'waiting for first shared doc';
      if (statusRight) statusRight.textContent = shareEnabled ? 'share link enabled' : 'copying repo name only';

      const files = Array.from(new Set(docs.map((d) => d.filePath))).slice(0, 20);
      fileList.innerHTML = files.map((fp) =>
        '<button class="fileItem" type="button" data-fp="' + escapeHtml(fp) + '">'
          + '<div class="fileName">' + escapeHtml(pathTail(fp) || fp) + '</div>'
          + '<div class="filePath">' + escapeHtml(fp) + '</div>'
        + '</button>'
      ).join('') || '<div class="empty">No shared files yet for this repo.</div>';
      fileList.querySelectorAll('.fileItem').forEach((el) => {
        el.addEventListener('click', () => vscode.postMessage({ type: 'openFile', filePath: el.getAttribute('data-fp') }));
      });

      if (docs[0]) {
        editorText.textContent = docs[0].diff || '';
        editorMeta.textContent = (docs[0].language || 'text') + ' | ' + (docs[0].repo || repoName || 'repo unknown');
      } else {
        editorText.textContent = '// Save a file to generate a diff...';
        editorMeta.textContent = 'Waiting for the first generated diff.';
      }

      cards.innerHTML = docs.map((d) => {
        const tags = (d.tags || []).map((t) => '<span class="tag">#' + escapeHtml(t) + '</span>').join('');
        const vote = votes.get(d.id);
        const chips = [
          '<span class="chip">' + escapeHtml(d.language || 'text') + '</span>',
          d.branch ? '<span class="chip">' + escapeHtml(d.branch) + '</span>' : '',
          '<span class="chip">' + escapeHtml(new Date(d.createdAt).toLocaleTimeString()) + '</span>'
        ].join('');
        return '<article class="card">'
          + '<div class="cardTop"><div class="cardTitle">' + escapeHtml(pathTail(d.filePath || '') || d.filePath || 'unknown') + '</div><div class="metaRow">' + chips + '</div></div>'
          + '<div class="cardSummary">' + escapeHtml(d.summary || '') + '</div>'
          + '<div class="tagRow">' + (tags || '<span class="chip">no tags</span>') + '</div>'
          + '<div class="cardFooter">'
          +   '<span class="chip">thumbs up ' + Number(d.votes?.up || 0) + '</span>'
          +   '<span class="chip">flagged ' + Number(d.votes?.down || 0) + '</span>'
          + '</div>'
          + '<div class="voteRow">'
          +   '<span class="panelNote">Stored feedback</span>'
          +   '<div class="voteGroup">'
          +     '<button class="voteBtn up' + (vote === 'up' ? ' active' : '') + '" data-id="' + escapeHtml(d.id) + '" data-dir="up">Thumbs up</button>'
          +     '<button class="voteBtn down' + (vote === 'down' ? ' active' : '') + '" data-id="' + escapeHtml(d.id) + '" data-dir="down">Flag</button>'
          +   '</div>'
          + '</div>'
        + '</article>';
      }).join('') || '<div class="empty">Waiting for the first repo doc. Save from the extension and the shared cards will appear here.</div>';

      cards.querySelectorAll('.voteBtn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const el = e.currentTarget;
          const id = el.getAttribute('data-id');
          const dir = el.getAttribute('data-dir');
          if (id && dir) sendVote(id, dir);
        });
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'docs') {
        docs = Array.isArray(msg.docs) ? msg.docs : [];
        repoName = String(msg.repo || '');
        branchName = String(msg.branch || '');
        shareEnabled = Boolean(msg.shareEnabled);
        render();
        speakLatest();
      }
    });

    document.getElementById('speakBtn')?.addEventListener('click', () => {
      lastSpokenId = null;
      speakLatest();
    });

    document.getElementById('shareRepoBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'shareRepo' });
    });

    render();
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Living Codebase Narrator');
  context.subscriptions.push(output);

  const snapshots = new Map<string, Snapshot>();
  const pending = new Map<string, Pending>();
  const provider = new SidebarProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, provider));

  const author = vscode.env.machineId ? `dev-${vscode.env.machineId.slice(0, 6)}` : 'dev';

  async function handleSave(doc: vscode.TextDocument) {
    if (doc.isUntitled) return;
    if (doc.uri.scheme !== 'file') return;

    const cfg = getConfig();
    const fsPath = doc.uri.fsPath;
    if (isIgnored(fsPath, cfg.ignoreGlobs)) {
      log(`skip (ignored glob): ${fsPath}`);
      return;
    }

    const prev = snapshots.get(fsPath)?.text ?? '';
    const next = doc.getText();
    snapshots.set(fsPath, { text: next, version: doc.version });

    const diff = createTwoFilesPatch(fsPath, fsPath, prev, next, '', '', { context: 3 });
    const changedLines = countChangedLines(diff);
    if (changedLines < cfg.minChangedLines) {
      log(`skip (below minChangedLines=${cfg.minChangedLines}): ${changedLines} lines â€” ${fsPath}`);
      return;
    }

    const contextText = next.slice(0, 8000);
    const key = fsPath;

    const existing = pending.get(key);
    if (existing) clearTimeout(existing.timer);

    const latest = {
      uri: doc.uri,
      languageId: doc.languageId,
      filePath: fsPath,
      diff,
      context: contextText,
      changedLines
    };

    log(`queued delta in ${cfg.debounceMs}ms (${changedLines} lines) â€” ${fsPath}`);

    const timer = setTimeout(async () => {
      pending.delete(key);
      const gitContext = await getGitContext(latest.uri);
      const payload = {
        sessionId: DEFAULT_SESSION_ID,
        author,
        repo: gitContext.repo,
        branch: gitContext.branch,
        filePath: latest.filePath,
        language: latest.languageId,
        diff: latest.diff,
        context: latest.context,
        changedLines: latest.changedLines,
        source: 'vscode'
      };
      try {
        await postDelta(payload, cfg.backendUrl);
        log(`POST /deltas ok â€” ${latest.filePath}`);
        void vscode.window.setStatusBarMessage('LCN: doc sent', 2500);
      } catch (e) {
        const msg = String(e);
        log(`POST /deltas failed â€” ${msg}`);
        vscode.window.setStatusBarMessage(`LCN: failed to send delta (${msg})`, 8000);
        void vscode.window.showErrorMessage(`LCN: ${msg}`, 'Show log').then((c) => {
          if (c === 'Show log') output?.show(true);
        });
      }
    }, cfg.debounceMs);

    pending.set(key, { timer, latest });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('lcn.pingBackend', async () => {
      const { backendUrl } = getConfig();
      try {
        const res = await fetch(`${backendUrl.replace(/\/$/, '')}/health`);
        const text = await res.text();
        log(`GET /health â€” ${res.status} â€” ${text}`);
        output?.show(true);
        void vscode.window.showInformationMessage(`LCN: backend ${res.status}`);
      } catch (e) {
        log(`GET /health failed â€” ${String(e)}`);
        output?.show(true);
        void vscode.window.showErrorMessage(`LCN: cannot reach backend (${String(e)})`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lcn.showLog', () => {
      output?.show(true);
    })
  );

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => void handleSave(doc)));

  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.scheme === 'file' && !d.isUntitled) {
      snapshots.set(d.uri.fsPath, { text: d.getText(), version: d.version });
    }
  }
}

export function deactivate() {}
