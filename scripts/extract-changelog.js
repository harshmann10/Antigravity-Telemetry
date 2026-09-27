#!/usr/bin/env node

/**
 * Extracts release notes for a specific version/tag from CHANGELOG.md.
 * If no tag is provided or no exact match is found, extracts the latest (topmost) release section.
 *
 * Usage:
 *   node scripts/extract-changelog.js [tagOrVersion] [outputPath]
 *
 * Output:
 *   - Writes markdown content to outputPath (if provided)
 *   - Prints extracted content to stdout
 *   - Sets GitHub Actions step outputs if $GITHUB_OUTPUT is set
 */

const fs = require('fs');
const path = require('path');

function extractChangelog(tagOrVersion, changelogPath = path.join(__dirname, '..', 'CHANGELOG.md')) {
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`Changelog not found at: ${changelogPath}`);
  }

  const raw = fs.readFileSync(changelogPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      if (current) {
        sections.push(current);
      }
      current = {
        header: line.substring(3).trim(),
        rawHeader: line,
        lines: []
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    sections.push(current);
  }

  if (sections.length === 0) {
    return {
      title: tagOrVersion || 'Release',
      notes: 'No release notes found in CHANGELOG.md'
    };
  }

  // Find matching section
  let match = null;
  if (tagOrVersion) {
    const cleanTag = String(tagOrVersion).trim();
    const cleanVer = cleanTag.replace(/^v/, ''); // e.g. v1.0.0 -> 1.0.0

    match = sections.find(s => {
      const h = s.header.toLowerCase();
      return (
        h.includes(cleanTag.toLowerCase()) ||
        h.includes(cleanVer.toLowerCase())
      );
    });
  }

  // Fallback to top section if no match found
  if (!match) {
    match = sections[0];
  }

  // Clean trailing horizontal rules (---) and empty lines
  const bodyLines = match.lines.slice();
  while (bodyLines.length > 0) {
    const last = bodyLines[bodyLines.length - 1].trim();
    if (!last || last === '---') {
      bodyLines.pop();
    } else {
      break;
    }
  }

  // Remove leading empty lines
  while (bodyLines.length > 0 && !bodyLines[0].trim()) {
    bodyLines.shift();
  }

  const notes = bodyLines.join('\n').trim();

  return {
    title: match.header,
    notes: notes || 'No release notes provided.'
  };
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const tag = args[0] || process.env.GITHUB_REF_NAME || '';
  const outputPath = args[1] || '';

  try {
    const res = extractChangelog(tag);

    if (outputPath) {
      fs.writeFileSync(outputPath, res.notes + '\n', 'utf8');
      console.log(`Release notes written to: ${outputPath}`);
    }

    // Set GitHub Actions step output if running in workflow
    const ghOutput = process.env.GITHUB_OUTPUT;
    if (ghOutput) {
      try {
        const delimiter = `EOF_${Date.now()}`;
        const outputText = [
          `release_title=${res.title}`,
          `release_notes<<${delimiter}`,
          res.notes,
          delimiter,
          ''
        ].join('\n');
        fs.appendFileSync(ghOutput, outputText, 'utf8');
      } catch (e) {
        console.warn(`Warning: Could not write to GITHUB_OUTPUT: ${e.message}`);
      }
    }

    console.log(`\n--- Extracted Release: ${res.title} ---\n`);
    console.log(res.notes);
  } catch (err) {
    console.error(`Error extracting changelog: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { extractChangelog };
