import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocEntry, HealthResponse } from '@lcn/types';
import { BrandMark } from './BrandMark';

const POLL_MS = 1500;
const LCN_API_BASE = (import.meta.env.VITE_LCN_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || 'http://localhost:8787';
const APP_BACKEND_BASE = (import.meta.env.VITE_APP_BACKEND_URL as string | undefined)?.replace(/\/$/, '') || 'http://127.0.0.1:4000';
const APP_FRONTEND_BASE = (import.meta.env.VITE_APP_FRONTEND_URL as string | undefined)?.replace(/\/$/, '') || 'http://localhost:5173';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

type GithubStatus = {
  configured: boolean;
  connected: boolean;
  user: {
    login?: string | null;
  } | null;
};

function formatTime(value?: string | null) {
  if (!value) return '--';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(value?: string | null) {
  if (!value) return '--';
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function resolveAudioUrl(value?: string | null) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${LCN_API_BASE}${value.startsWith('/') ? value : `/${value}`}`;
}

function statusTone(enabled: boolean | undefined, connected?: boolean) {
  if (!enabled) return 'off';
  if (connected === false) return 'warn';
  return 'on';
}

function DetailList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="detailBlock">
      <div className="detailBlockLabel">{title}</div>
      <ul className="bulletList">
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function App() {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [voteBusy, setVoteBusy] = useState<string | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const lastAudioPlayedFor = useRef<string | null>(null);

  async function vote(docId: string, direction: 'up' | 'down') {
    setVoteBusy(docId + direction);
    try {
      const res = await fetch(`${LCN_API_BASE}/docs/${encodeURIComponent(docId)}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction })
      });
      if (!res.ok) return;
      const out = (await res.json()) as { doc?: DocEntry };
      if (out.doc) {
        setDocs((prev) => prev.map((d) => (d.id === docId ? out.doc! : d)));
      }
    } finally {
      setVoteBusy(null);
    }
  }

  const latest = docs[0] ?? null;
  const selectedDoc = useMemo(() => {
    if (!docs.length) return null;
    if (!selectedDocId) return docs[0];
    return docs.find((doc) => doc.id === selectedDocId) ?? docs[0];
  }, [docs, selectedDocId]);

  const timelineTitle = useMemo(() => {
    if (!selectedDoc) return 'Waiting for saves...';
    return `${selectedDoc.filePath} | ${selectedDoc.summary}`;
  }, [selectedDoc]);

  const totalVotes = useMemo(
    () => docs.reduce((sum, doc) => sum + doc.votes.up + doc.votes.down, 0),
    [docs]
  );
  const selectedAudioUrl = useMemo(() => resolveAudioUrl(selectedDoc?.audioUrl), [selectedDoc?.audioUrl]);

  const publishedCount = useMemo(
    () => docs.filter((doc) => doc.status === 'published').length,
    [docs]
  );

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const out = await fetchJson<{ ok: boolean; github: GithubStatus }>(`${APP_BACKEND_BASE}/api/github/status`);
        if (!cancelled) setGithub(out.github);
      } catch {
        if (!cancelled) setGithub(null);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!github?.connected) {
      return;
    }
    const tick = async () => {
      try {
        const h = await fetchJson<HealthResponse>(`${LCN_API_BASE}/health`);
        if (!cancelled) setHealth(h);
      } catch {
        // ignore
      }
      try {
        const out = await fetchJson<{ ok: boolean; docs: DocEntry[] }>(`${LCN_API_BASE}/docs?limit=50`);
        if (!cancelled) {
          setDocs(out.docs ?? []);
          setSelectedDocId((current) => {
            if (!out.docs?.length) return null;
            if (current && out.docs.some((doc) => doc.id === current)) return current;
            return out.docs[0].id;
          });
        }
      } catch {
        // ignore
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [github?.connected]);

  useEffect(() => {
    if (!latest) return;
    if (lastAudioPlayedFor.current === latest.id) return;
    lastAudioPlayedFor.current = latest.id;

    const audioUrl = resolveAudioUrl(latest.audioUrl);
    if (audioUrl) {
      const audio = new Audio(audioUrl);
      void audio.play().catch(() => {
        // autoplay may be blocked; ignore
      });
    }
  }, [latest]);

  if (!github?.connected) {
    const loginUrl = new URL(`${APP_FRONTEND_BASE}/github-login`);
    loginUrl.searchParams.set('autoconnect', '1');
    loginUrl.searchParams.set('source', 'living-narrator');
    loginUrl.searchParams.set('returnPath', '/');

    return (
      <div className="shell shellLogin">
        <div className="ambient ambientLeft" />
        <div className="ambient ambientRight" />
        <section className="loginPanel">
          <BrandMark />
          <div className="eyebrow">Extension handshake required</div>
          <h1 className="loginTitle">Narration starts after GitHub sign-in.</h1>
          <p className="loginText">
            This workspace shares the main app OAuth session. Open GitHub auth once, then the live doc stream unlocks here automatically.
          </p>
          <div className="promoGrid">
            <FeatureCard title="Narrate on save" text="Every meaningful edit gets turned into a short explanation before context disappears." />
            <FeatureCard title="Human-readable diffs" text="The feed keeps reasoning, summaries, tags, and playback in the same place." />
            <FeatureCard title="Built for active repos" text="You can sign in once, leave it open, and let the memory layer build itself." />
          </div>
          <div className="loginActions">
            <a className="primaryButton" href={loginUrl.toString()} target="_blank" rel="noreferrer">
              Continue with GitHub
            </a>
            <span className={`statusChip ${github?.configured === false ? 'off' : 'warn'}`}>
              {github?.configured === false ? 'OAuth not configured' : 'Waiting for sign-in'}
            </span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="ambient ambientLeft" />
      <div className="ambient ambientRight" />

      <header className="hero">
        <div className="heroCopy">
          <BrandMark />
          <div className="eyebrow">Live Engineering Memory</div>
          <h1 className="heroTitle">Code changes, translated into a readable story while the repo is still moving.</h1>
          <p className="heroText">
            The narrator watches saves from the extension, drafts explanation blocks, and keeps the latest reasoning visible without waiting for a commit or pull request.
          </p>
          <div className="heroMeta">
            <span className="statusChip on">GitHub {github?.user?.login || 'connected'}</span>
            <span className={`statusChip ${docs.length ? 'on' : 'off'}`}>{docs.length} docs in feed</span>
            <span className={`statusChip ${selectedAudioUrl ? 'on' : 'warn'}`}>
              Audio {selectedAudioUrl ? 'ready' : 'fallback'}
            </span>
          </div>
        </div>

        <div className="heroStats">
          <StatCard label="Latest file" value={selectedDoc?.language || '--'} detail={selectedDoc?.filePath || 'No document yet'} />
          <StatCard label="Published docs" value={String(publishedCount)} detail={selectedDoc ? `Updated ${formatDateTime(selectedDoc.updatedAt)}` : 'Waiting for save'} />
          <StatCard label="Feedback" value={String(totalVotes)} detail="Total helpful and not-quite votes" />
        </div>
      </header>

      <section className="promoGrid">
        <FeatureCard title="Extension to web" text="The same product mark now ties the VS Code surface, favicon, and dashboard together." />
        <FeatureCard title="Readable by default" text="The homepage foregrounds summary quality, change context, and audio handoff instead of raw telemetry." />
        <FeatureCard title="Made for demos" text="Login and empty states now feel intentional, which makes the product easier to explain in screenshots and walkthroughs." />
      </section>

      <section className="statusStrip">
        <StatusPill label="Backend" value={health ? 'online' : 'pending'} tone={statusTone(Boolean(health))} />
        <StatusPill label="Gemini" value={health?.integrations.gemini.configured ? 'on' : 'off'} tone={statusTone(health?.integrations.gemini.configured)} />
        <StatusPill label="Hugging Face" value={health?.integrations.huggingface.configured ? 'on' : 'off'} tone={statusTone(health?.integrations.huggingface.configured)} />
        <StatusPill label="ElevenLabs" value={health?.integrations.elevenlabs.configured ? 'on' : 'off'} tone={statusTone(health?.integrations.elevenlabs.configured)} />
        <StatusPill
          label="MongoDB"
          value={health?.integrations.mongodb.configured ? (health.integrations.mongodb.connected ? 'connected' : 'fallback') : 'off'}
          tone={statusTone(health?.integrations.mongodb.configured, health?.integrations.mongodb.connected)}
        />
      </section>

      <main className="workspace">
        <aside className="rail">
          <section className="panel">
            <div className="panelHeader">
              <div>
                <div className="panelTitle">Live feed</div>
                <div className="panelSubtitle">{timelineTitle}</div>
              </div>
              <div className="statusChip neutral">Polling {POLL_MS}ms</div>
            </div>
            <div className="feedList">
              {docs.map((doc, index) => (
                <button
                  type="button"
                  key={doc.id}
                  className={`feedCard ${selectedDoc?.id === doc.id ? 'isSelected' : ''}`}
                  onClick={() => setSelectedDocId(doc.id)}
                >
                  <div className="feedTop">
                    <span className="feedIndex">{String(index + 1).padStart(2, '0')}</span>
                    <span className="miniChip">{doc.language}</span>
                    <span className="miniChip">{formatTime(doc.createdAt)}</span>
                  </div>
                  <div className="feedFile">{doc.filePath}</div>
                  <div className="feedSummary">{doc.summary}</div>
                  <div className="feedFooter">
                    <span>{doc.status}</span>
                    <span>{doc.votes.up + doc.votes.down} votes</span>
                  </div>
                </button>
              ))}
              {docs.length === 0 ? <div className="emptyState">Save a file from the extension to start the narration stream.</div> : null}
            </div>
          </section>
        </aside>

        <section className="detail">
          {selectedDoc ? (
            <article className="panel detailPanel">
              <div className="detailHero">
                <div>
                  <div className="detailPath">{selectedDoc.filePath}</div>
                  <h2 className="detailTitle">{selectedDoc.summary}</h2>
                  <div className="detailMetaRow">
                    <span className="miniChip">{selectedDoc.language}</span>
                    <span className="miniChip">Created {formatDateTime(selectedDoc.createdAt)}</span>
                    <span className="miniChip">Updated {formatDateTime(selectedDoc.updatedAt)}</span>
                  </div>
                </div>
                <div className="votePanel">
                  <div className="voteScore">
                    <span>{selectedDoc.votes.up}</span>
                    <small>helpful</small>
                  </div>
                  <div className="voteScore">
                    <span>{selectedDoc.votes.down}</span>
                    <small>not quite</small>
                  </div>
                  <div className="voteActions">
                    <button type="button" className="softButton" disabled={voteBusy !== null} onClick={() => void vote(selectedDoc.id, 'up')}>
                      Helpful
                    </button>
                    <button type="button" className="softButton" disabled={voteBusy !== null} onClick={() => void vote(selectedDoc.id, 'down')}>
                      Needs work
                    </button>
                  </div>
                </div>
              </div>

              <div className="detailGrid">
                <DetailList title="What changed" items={selectedDoc.whatChanged} />
                <DetailList title="Why it matters" items={selectedDoc.whyItMatters} />
              </div>

              <section className="detailBlock">
                <div className="detailBlockLabel">Tags</div>
                <div className="tagRow">
                  {selectedDoc.tags.map((tag) => (
                    <span className="tagPill" key={tag}>
                      #{tag}
                    </span>
                  ))}
                  {selectedDoc.tags.length === 0 ? <span className="mutedText">No tags generated.</span> : null}
                </div>
              </section>

              <section className="detailBlock">
                <div className="detailBlockLabel">Audio</div>
                {selectedAudioUrl ? (
                  <div className="audioShell">
                    <audio controls preload="none" src={selectedAudioUrl} />
                  </div>
                ) : (
                  <div className="mutedPanel">ElevenLabs audio is unavailable for this entry, so the doc is shown as text only.</div>
                )}
              </section>

              <section className="detailBlock">
                <div className="detailBlockLabel">Annotations</div>
                {selectedDoc.annotations.length > 0 ? (
                  <div className="annotationList">
                    {selectedDoc.annotations.map((annotation) => (
                      <article className="annotationCard" key={annotation.id}>
                        <div className="annotationMeta">
                          <strong>{annotation.author}</strong>
                          <span>{formatDateTime(annotation.createdAt)}</span>
                        </div>
                        <div>{annotation.text}</div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="mutedPanel">No inline annotations have been added yet.</div>
                )}
              </section>

              <details className="diffPanel">
                <summary>Show raw diff</summary>
                <pre>{selectedDoc.diff}</pre>
              </details>
            </article>
          ) : (
            <section className="panel detailPanel emptyDetail">
              <div className="detailTitle">No narration yet</div>
              <p className="heroText">When the extension posts a save event, the first generated explanation will appear here with its full context and diff.</p>
            </section>
          )}
        </section>
      </main>
    </div>
  );
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="statCard">
      <div className="statLabel">{label}</div>
      <div className="statValue">{value}</div>
      <div className="statDetail">{detail}</div>
    </article>
  );
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`statusChip ${tone}`}>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function FeatureCard({ title, text }: { title: string; text: string }) {
  return (
    <article className="featureCard">
      <div className="featureAccent" />
      <h2>{title}</h2>
      <p>{text}</p>
    </article>
  );
}
