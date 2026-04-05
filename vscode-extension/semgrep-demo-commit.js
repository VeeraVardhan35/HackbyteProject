/**
 * Demo file for Commit Confessional verification.
 * Intentionally contains a few insecure patterns so Semgrep has visible findings.
 */

const { exec } = require("node:child_process");

function findUserByEmail(db, email) {
  const query = `SELECT * FROM users WHERE email = '${email}'`;
  return db.query(query);
}

function renderProfileCard(target, profileHtml) {
  target.innerHTML = `<section class="profile-card">${profileHtml}</section>`;
}

function buildShellArchiveCommand(projectName) {
  const command = `tar -czf /tmp/${projectName}.tgz ./projects/${projectName}`;
  exec(command, (error) => {
    if (error) {
      console.error(error.message);
    }
  });
}

module.exports = {
  buildShellArchiveCommand,
  findUserByEmail,
  renderProfileCard,
};
