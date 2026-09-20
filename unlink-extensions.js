const fs = require('fs');
const path = require('path');
const os = require('os');

const userHome = os.homedir();
const links = [
  path.join(userHome, '.vscode', 'extensions', 'antigravity-telemetry'),
  'G:\\vs code insider\\data\\extensions\\antigravity-telemetry'
];

console.log('=== Unlinking Antigravity Telemetry from VS Code ===');

for (const linkPath of links) {
  const parent = path.dirname(linkPath);
  if (!fs.existsSync(parent)) continue;

  if (fs.existsSync(linkPath)) {
    try {
      // fs.rmSync removes the junction link without touching the target repository
      fs.rmSync(linkPath, { recursive: true, force: true });
      console.log(`[REMOVED LINK] ${linkPath}`);
    } catch (err) {
      console.error(`[ERROR] Failed to remove ${linkPath}:`, err.message);
    }
  }

  // 1. Remove from extensions.json
  const extensionsFile = path.join(parent, 'extensions.json');
  if (fs.existsSync(extensionsFile)) {
    try {
      let exts = JSON.parse(fs.readFileSync(extensionsFile, 'utf8'));
      const initialLen = exts.length;
      exts = exts.filter(e => !(e.identifier && (e.identifier.id === 'local.antigravity-telemetry' || e.identifier.id === 'antigravity-telemetry')));
      if (exts.length !== initialLen) {
        fs.writeFileSync(extensionsFile, JSON.stringify(exts, null, 2));
        console.log(`[DEREGISTERED] Removed entry from ${extensionsFile}`);
      }
    } catch (err) {
      console.warn(`[WARN] Could not update ${extensionsFile}:`, err.message);
    }
  }

  // 2. Clean .obsolete so no blacklist flags linger
  const obsoleteFile = path.join(parent, '.obsolete');
  if (fs.existsSync(obsoleteFile)) {
    try {
      const obs = JSON.parse(fs.readFileSync(obsoleteFile, 'utf8'));
      let modified = false;
      for (const key of Object.keys(obs)) {
        if (key.includes('antigravity-telemetry')) {
          delete obs[key];
          modified = true;
        }
      }
      if (modified) {
        fs.writeFileSync(obsoleteFile, JSON.stringify(obs));
        console.log(`[CLEANED] Cleaned flags from ${obsoleteFile}`);
      }
    } catch (err) { }
  }
}

console.log('\nUnlinking complete! Your source code in "G:\\web dev\\antigravity-telemetry" is completely safe and untouched.');
console.log('Reload VS Code (Ctrl+Shift+P -> Developer: Reload Window) to update the IDE.');
