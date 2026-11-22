import path from 'node:path';
import { walkElements } from '../xml/parser.js';

const GLYPH_TAGS = new Set(['time', 'imagenumber', 'imageseries']);

function literalExpression(expr) {
  const quoted = /^(['"])([^'"]*)\1$/.exec(expr);
  return quoted ? quoted[2] : null;
}

export function auditResourceReferences(doc, assetIndex) {
  if (!assetIndex) return { checked: false, counts: {}, issues: [] };

  const counts = { resolved: 0, missing: 0, dynamic: 0, external: 0 };
  const issues = [];
  const families = new Map();
  const filenames = [...assetIndex.relToEntry.keys()].map(name => name.toLowerCase());

  function hasFamily(src) {
    const key = src.toLowerCase();
    if (!families.has(key)) {
      const ext = path.posix.extname(key);
      const stem = key.slice(0, key.length - ext.length);
      const found = filenames.some(name => {
        if (!name.startsWith(stem) || !name.endsWith(ext)) return false;
        return /^[_0-9]/.test(name.slice(stem.length));
      });
      families.set(key, found);
    }
    return families.get(key);
  }

  function record(node, attribute, value, status) {
    counts[status]++;
    if (status !== 'resolved') issues.push({ nodeId: node.nodeId, tag: node.tag, attribute, value, status });
  }

  function checkPath(node, attribute, value, usesFamily = false) {
    const src = value.replace(/\\/g, '/').replace(/^\.\//, '');
    const inArchive = path.posix.normalize(assetIndex.basePrefix + src);
    if (/^(?:\/|[A-Za-z][\w+.-]*:)/.test(src) || /^\.\.(?:\/|$)/.test(inArchive)) {
      record(node, attribute, value, 'external');
    } else if (
      assetIndex.resolveRel(src) || assetIndex.archive.has(inArchive) || (usesFamily && hasFamily(src))
    ) {
      record(node, attribute, value, 'resolved');
    } else {
      record(node, attribute, value, 'missing');
    }
  }

  walkElements(doc.root, node => {
    for (const attribute of ['src', 'defaultBitmap']) {
      const value = node.attrs[attribute]?.trim();
      if (!value) continue;
      const usesFamily = attribute === 'src' && (GLYPH_TAGS.has(node.tagLower) || node.attrs.srcid !== undefined);
      checkPath(node, attribute, literalExpression(value) ?? value, usesFamily);
    }
    if (node.attrs.srcid?.trim()) {
      record(node, 'srcid', node.attrs.srcid, 'dynamic');
    }
    if (node.attrs.srcExp?.trim()) {
      const value = literalExpression(node.attrs.srcExp.trim());
      if (value) checkPath(node, 'srcExp', value);
      else record(node, 'srcExp', node.attrs.srcExp, 'dynamic');
    }
  });

  return { checked: true, counts, issues };
}
