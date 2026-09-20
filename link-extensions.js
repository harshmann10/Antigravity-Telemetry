const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// The current directory (G:\web dev\antigravity-telemetry)
const targetDir = __dirname;

const userHome = os.homedir();
const candidateLinks = [
  path.join(userHome, '.vscode', 'extensions', 'antigravity-telemetry'),
  'G:\\vs code insider\\data\\extensions\\antigravity-telemetry'
];

console.log('=== Linking Antigravity Telemetry to VS Code ===');
console.log('Source Repository:', targetDir);

for (const linkPath of candidateLinks) {
  const parent = path.dirname(linkPath);
  if (!fs.existsSync(parent)) {
    console.log(`Skipping (parent folder not found): ${parent}`);
    continue;
  }

  try {
    if (fs.existsSync(linkPath)) {
      fs.rmSync(linkPath, { recursive: true, force: true });
      console.log(`Cleaned existing folder: ${linkPath}`);
    }
    const out = execSync(`cmd /c mklink /J "${linkPath}" "${targetDir}"`).toString().trim();
    console.log(`[SUCCESS] ${out}`);

    // 1. Clean any stale .obsolete blacklist flag in VS Code
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
          console.log(`[CLEANED] Removed obsolete blacklist flags from ${obsoleteFile}`);
        }
      } catch (err) {
        console.warn(`[WARN] Could not parse ${obsoleteFile}:`, err.message);
      }
    }

    // 2. Ensure extension is registered in VS Code's extensions.json index
    const extensionsFile = path.join(parent, 'extensions.json');
    if (fs.existsSync(extensionsFile)) {
      try {
        const exts = JSON.parse(fs.readFileSync(extensionsFile, 'utf8'));
        const extId = 'local.antigravity-telemetry';
        const hasEntry = exts.some(e => e.identifier && (e.identifier.id === extId || e.identifier.id === 'antigravity-telemetry'));
        if (!hasEntry) {
          const normalizedPath = linkPath.replace(/\\/g, '/');
          exts.push({
            identifier: { id: extId },
            version: '1.0.0',
            location: {
              $mid: 1,
              fsPath: linkPath,
              _sep: 1,
              external: `file:///${normalizedPath}`,
              path: `/${normalizedPath}`,
              scheme: 'file'
            },
            relativeLocation: path.basename(linkPath)
          });
          fs.writeFileSync(extensionsFile, JSON.stringify(exts, null, 2));
          console.log(`[REGISTERED] Added extension to ${extensionsFile}`);
        } else {
          console.log(`[VERIFIED] Extension already registered in ${extensionsFile}`);
        }
      } catch (err) {
        console.warn(`[WARN] Could not update ${extensionsFile}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[ERROR] Failed linking to ${linkPath}:`, err.message);
  }
}

console.log('\nDone! Reload VS Code (Ctrl+Shift+P -> Developer: Reload Window) to apply changes.');
