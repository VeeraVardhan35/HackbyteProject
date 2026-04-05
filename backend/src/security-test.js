/**
 * Test file demonstrating security findings for semgrep analysis
 */

// ============================================================================
// SECURITY ISSUE 1: SQL Injection - String Interpolation in Query
// ============================================================================
function getUserData(userId) {
  const query = `SELECT * FROM users WHERE id = '${userId}'`;
  // This is vulnerable to SQL injection
  database.query(query);
}

// ============================================================================
// SECURITY ISSUE 2: Cross-Site Scripting (XSS) via innerHTML
// ============================================================================
function renderUserContent(userInput) {
  const container = document.getElementById('content');
  // User-controlled data directly into innerHTML = XSS vulnerability
  container.innerHTML = `<div>${userInput}</div>`;
}

// ============================================================================
// SECURITY ISSUE 3: Command Injection via exec
// ============================================================================
function processFile(filename) {
  const { exec } = require('child_process');
  // Interpolated shell command = command injection vulnerability
  exec(`cat ${filename} | grep secret`);
}

// ============================================================================
// SECURITY ISSUE 4: Unsafe JSON Parsing
// ============================================================================
function parseUserData(jsonString) {
  // Using eval instead of JSON.parse is dangerous
  const data = eval(`(${jsonString})`);
  return data;
}

// ============================================================================
// SECURE EXAMPLES (What should be done instead)
// ============================================================================

// Correct: Use parameterized queries
function getUserDataSecure(userId) {
  const query = 'SELECT * FROM users WHERE id = ?';
  database.query(query, [userId]);
}

// Correct: Use textContent instead of innerHTML
function renderUserContentSecure(userInput) {
  const container = document.getElementById('content');
  const div = document.createElement('div');
  div.textContent = userInput;
  container.appendChild(div);
}

// Correct: Use execFile with arguments array
function processFileSecure(filename) {
  const { execFile } = require('child_process');
  execFile('cat', [filename]);
}

// Correct: Use JSON.parse
function parseUserDataSecure(jsonString) {
  const data = JSON.parse(jsonString);
  return data;
}
