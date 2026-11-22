/**
 * Lossless XML parser & serializer tailored for Huawei Lockscreen manifest.xml.
 * - Preserves XML declaration, comments, exact tag casing, attribute order, and self-closing style.
 * - Properly decodes/encodes XML entities.
 * - Assigns deterministic `nodeId` to every element node.
 */

export function decodeXmlEntities(str) {
  if (!str || !str.includes('&')) return str;
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function encodeXmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function encodeXmlText(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function parseXml(xmlText) {
  if (typeof xmlText !== 'string') throw new Error('XML input must be a string');
  const text = xmlText.charCodeAt(0) === 0xfeff ? xmlText.slice(1) : xmlText;
  let pos = 0;
  let nextId = 1;
  const len = text.length;

  const doc = {
    type: 'document',
    declaration: null,
    children: [],
    root: null,
  };

  const stack = [{ children: doc.children, tag: null }];

  function skipWs() {
    while (pos < len && /\s/.test(text[pos])) pos++;
  }

  while (pos < len) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) {
      const tail = text.slice(pos);
      if (tail.trim()) {
        stack[stack.length - 1].children.push({ type: 'text', value: decodeXmlEntities(tail) });
      }
      break;
    }

    if (lt > pos) {
      const between = text.slice(pos, lt);
      if (between.trim()) {
        stack[stack.length - 1].children.push({ type: 'text', value: decodeXmlEntities(between) });
      }
      pos = lt;
    }

    // XML declaration / Processing Instruction
    if (text.startsWith('<?', pos)) {
      const end = text.indexOf('?>', pos + 2);
      if (end === -1) throw new Error('Unclosed processing instruction');
      const raw = text.slice(pos, end + 2);
      if (raw.startsWith('<?xml')) {
        doc.declaration = raw;
      } else {
        stack[stack.length - 1].children.push({ type: 'pi', raw });
      }
      pos = end + 2;
      continue;
    }

    // Comment
    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      if (end === -1) throw new Error('Unclosed XML comment');
      const value = text.slice(pos + 4, end);
      stack[stack.length - 1].children.push({ type: 'comment', value });
      pos = end + 3;
      continue;
    }

    // CDATA
    if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos + 9);
      if (end === -1) throw new Error('Unclosed CDATA');
      const value = text.slice(pos + 9, end);
      stack[stack.length - 1].children.push({ type: 'cdata', value });
      pos = end + 3;
      continue;
    }

    // DOCTYPE / other <!...>
    if (text.startsWith('<!', pos)) {
      const end = text.indexOf('>', pos + 2);
      if (end === -1) throw new Error('Unclosed declaration');
      pos = end + 1;
      continue;
    }

    // Closing tag
    if (text.startsWith('</', pos)) {
      const end = text.indexOf('>', pos + 2);
      if (end === -1) throw new Error('Unclosed closing tag');
      const closeName = text.slice(pos + 2, end).trim();
      const top = stack[stack.length - 1];
      if (!top || top.tag !== closeName) {
        throw new Error(`Mismatched closing tag </${closeName}>, expected </${top ? top.tag : 'EOF'}> at offset ${pos}`);
      }
      stack.pop();
      pos = end + 1;
      continue;
    }

    // Opening tag
    pos++; // skip '<'
    const tagMatch = /^[A-Za-z_][A-Za-z0-9_:\.-]*/.exec(text.slice(pos));
    if (!tagMatch) throw new Error(`Invalid tag name at offset ${pos}: ${text.slice(pos, pos + 30)}`);
    const tag = tagMatch[0];
    pos += tag.length;

    const attrs = {};
    const attrOrder = [];
    let selfClosing = false;

    while (pos < len) {
      skipWs();
      if (text.startsWith('/>', pos)) {
        selfClosing = true;
        pos += 2;
        break;
      }
      if (text[pos] === '>') {
        pos += 1;
        break;
      }
      const attrMatch = /^([A-Za-z_][A-Za-z0-9_:\.-]*)\s*=/.exec(text.slice(pos));
      if (!attrMatch) {
        throw new Error(`Invalid attribute near offset ${pos} in <${tag}>: ${text.slice(pos, pos + 40)}`);
      }
      const attrName = attrMatch[1];
      pos += attrMatch[0].length;
      skipWs();
      const quote = text[pos];
      if (quote !== '"' && quote !== "'") {
        throw new Error(`Expected quote for attribute ${attrName} in <${tag}> at offset ${pos}`);
      }
      pos++;
      const valEnd = text.indexOf(quote, pos);
      if (valEnd === -1) throw new Error(`Unclosed attribute value for ${attrName} in <${tag}>`);
      const rawVal = text.slice(pos, valEnd);
      if (Object.hasOwn(attrs, attrName)) {
        throw new Error(`Duplicate attribute ${attrName} in <${tag}> at offset ${pos}`);
      }
      attrs[attrName] = decodeXmlEntities(rawVal);
      attrOrder.push(attrName);
      pos = valEnd + 1;
    }

    const node = {
      type: 'element',
      nodeId: `n_${nextId++}`,
      tag,
      tagLower: tag.toLowerCase(),
      attrs,
      attrOrder,
      children: [],
      selfClosing,
      parent: stack.length > 1 ? stack[stack.length - 1] : null,
    };

    stack[stack.length - 1].children.push(node);
    if (stack.length === 1) {
      if (doc.root) throw new Error(`Unexpected second root element <${tag}>`);
      doc.root = node;
    }
    if (!selfClosing) {
      stack.push(node);
    }
  }

  if (stack.length !== 1) {
    throw new Error(`Unclosed tag <${stack[stack.length - 1].tag}> at EOF`);
  }
  if (!doc.root) throw new Error('XML document has no root element');
  return doc;
}

export function setNodeAttr(node, name, value) {
  if (!(name in node.attrs)) {
    node.attrOrder.push(name);
  }
  node.attrs[name] = String(value);
}

export function cloneXmlDoc(doc) {
  function cloneNode(n, parent) {
    if (n.type !== 'element') return { ...n };
    const copy = {
      type: 'element',
      nodeId: n.nodeId,
      tag: n.tag,
      tagLower: n.tagLower,
      attrs: { ...n.attrs },
      attrOrder: [...n.attrOrder],
      children: [],
      selfClosing: n.selfClosing,
      parent,
    };
    copy.children = n.children.map(c => cloneNode(c, copy));
    return copy;
  }
  const cloned = {
    type: 'document',
    declaration: doc.declaration,
    children: [],
    root: null,
  };
  for (const c of doc.children) {
    const cc = cloneNode(c, null);
    cloned.children.push(cc);
    if (cc.type === 'element' && !cloned.root) cloned.root = cc;
  }
  return cloned;
}

export function serializeXml(doc, { indentUnit = '    ' } = {}) {
  const lines = [];
  if (doc.declaration) {
    lines.push(doc.declaration);
  } else {
    lines.push('<?xml version="1.0" encoding="utf-8"?>');
  }

  function renderNode(node, depth) {
    const pad = indentUnit.repeat(depth);
    if (node.type === 'comment') {
      lines.push(`${pad}<!--${node.value}-->`);
      return;
    }
    if (node.type === 'cdata') {
      lines.push(`${pad}<![CDATA[${node.value}]]>`);
      return;
    }
    if (node.type === 'pi') {
      lines.push(`${pad}${node.raw}`);
      return;
    }
    if (node.type === 'text') {
      lines.push(`${pad}${encodeXmlText(node.value)}`);
      return;
    }

    const keys = [];
    for (const k of node.attrOrder) {
      if (k in node.attrs && !keys.includes(k)) keys.push(k);
    }
    for (const k of Object.keys(node.attrs)) {
      if (!keys.includes(k)) keys.push(k);
    }

    const attrStr = keys.map(k => `${k}="${encodeXmlAttr(node.attrs[k])}"`).join(' ');
    const open = attrStr ? `<${node.tag} ${attrStr}` : `<${node.tag}`;

    if (node.children.length === 0) {
      lines.push(`${pad}${open} />`);
      return;
    }

    if (node.children.length === 1 && node.children[0].type === 'text') {
      lines.push(`${pad}${open}>${encodeXmlText(node.children[0].value)}</${node.tag}>`);
      return;
    }

    lines.push(`${pad}${open}>`);
    for (const child of node.children) {
      renderNode(child, depth + 1);
    }
    lines.push(`${pad}</${node.tag}>`);
  }

  for (const child of doc.children) {
    renderNode(child, 0);
  }
  return lines.join('\n') + '\n';
}

export function walkElements(root, visitor) {
  function visit(node, ancestors) {
    if (node.type !== 'element') return;
    visitor(node, ancestors);
    const nextAnc = [...ancestors, node];
    for (const c of node.children) {
      visit(c, nextAnc);
    }
  }
  if (root) visit(root, []);
}
