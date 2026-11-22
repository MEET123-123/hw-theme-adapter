/**
 * Huawei Lockscreen MAML-style Expression AST Parser, Evaluator & Symbolic Rewriter.
 */

const FUNCTIONS = {
  eq: (a, b) => (a === b || (Number(a) === Number(b) && !Number.isNaN(Number(a)) && a !== '' && b !== '')) ? 1 : 0,
  ne: (a, b) => (FUNCTIONS.eq(a, b) ? 0 : 1),
  gt: (a, b) => (Number(a) > Number(b) ? 1 : 0),
  ge: (a, b) => (Number(a) >= Number(b) ? 1 : 0),
  lt: (a, b) => (Number(a) < Number(b) ? 1 : 0),
  le: (a, b) => (Number(a) <= Number(b) ? 1 : 0),
  not: (a) => (Number(a) ? 0 : 1),
  and: (...args) => (args.every(v => Boolean(Number(v))) ? 1 : 0),
  or: (...args) => (args.some(v => Boolean(Number(v))) ? 1 : 0),
  ifelse: (...args) => {
    for (let i = 0; i + 1 < args.length; i += 2) {
      if (Number(args[i])) return args[i + 1];
    }
    return args.length % 2 === 1 ? args[args.length - 1] : 0;
  },
  min: (...args) => Math.min(...args.map(Number)),
  max: (...args) => Math.max(...args.map(Number)),
  abs: (a) => Math.abs(Number(a)),
  int: (a) => Math.trunc(Number(a) || 0),
  round: (a) => Math.round(Number(a) || 0),
  floor: (a) => Math.floor(Number(a) || 0),
  ceil: (a) => Math.ceil(Number(a) || 0),
  sin: (a) => Math.sin(Number(a) || 0),
  cos: (a) => Math.cos(Number(a) || 0),
  tan: (a) => Math.tan(Number(a) || 0),
  atan: (a) => Math.atan(Number(a) || 0),
  asin: (a) => Math.asin(Math.max(-1, Math.min(1, Number(a) || 0))),
  acos: (a) => Math.acos(Math.max(-1, Math.min(1, Number(a) || 0))),
  sqrt: (a) => Math.sqrt(Math.max(0, Number(a) || 0)),
  pow: (a, b) => Math.pow(Number(a) || 0, Number(b) || 0),
  rand: () => 0.42, // deterministic snapshot value
  plus: (...args) => args.reduce((s, v) => s + (Number(v) || 0), 0),
  digit: (num, pos) => {
    const n = Math.abs(Math.trunc(Number(num) || 0));
    const p = Math.max(1, Math.trunc(Number(pos) || 1));
    return Math.floor(n / Math.pow(10, p - 1)) % 10;
  },
  isnull: (a) => (a === null || a === undefined ? 1 : 0),
  len: (s) => String(s ?? '').length,
  substr: (s, start, length) => {
    const str = String(s ?? '');
    const st = Math.max(0, Math.trunc(Number(start) || 0));
    if (length === undefined) return str.slice(st);
    return str.slice(st, st + Math.max(0, Math.trunc(Number(length) || 0)));
  },
  strContains: (s, sub) => (String(s ?? '').includes(String(sub ?? '')) ? 1 : 0),
  strIsEmpty: (s) => (String(s ?? '').length === 0 ? 1 : 0),
  strIndexOf: (s, sub) => String(s ?? '').indexOf(String(sub ?? '')),
  strReplaceAll: (s, target, repl) => String(s ?? '').split(String(target ?? '')).join(String(repl ?? '')),
  argb: (a, r, g, b) => {
    const aa = (Math.trunc(Number(a) || 0) & 0xff) << 24;
    const rr = (Math.trunc(Number(r) || 0) & 0xff) << 16;
    const gg = (Math.trunc(Number(g) || 0) & 0xff) << 8;
    const bb = Math.trunc(Number(b) || 0) & 0xff;
    return (aa | rr | gg | bb) >>> 0;
  },
  formatFloat: (val, digits = 1) => Number(val || 0).toFixed(Math.max(0, Number(digits) || 0)),
};

export function tokenizeExpr(src, diagnostics = null) {
  const tokens = [];
  const s = String(src ?? '');
  let i = 0;
  const len = s.length;

  while (i < len) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // String literal '...'
    if (ch === "'") {
      let j = i + 1;
      let val = '';
      while (j < len && s[j] !== "'") {
        if (s[j] === '\\' && j + 1 < len) {
          val += s[j + 1];
          j += 2;
        } else {
          val += s[j++];
        }
      }
      tokens.push({ type: 'str', value: val });
      if (j >= len) diagnostics?.push({ kind: 'syntax', reason: 'Unclosed string literal' });
      i = j < len ? j + 1 : len;
      continue;
    }

    // Variable #name or @name (supports dotted paths like #Weather.today.currentTem or #system.time.hour1)
    if (ch === '#' || ch === '@') {
      const kind = ch;
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_.]/.test(s[j])) j++;
      if (j === i + 1) {
        diagnostics?.push({ kind: 'syntax', reason: `Missing variable name after ${kind}` });
        tokens.push({ type: 'num', value: 0 });
      } else {
        tokens.push({ type: 'var', kind, name: s.slice(i + 1, j), raw: s.slice(i, j) });
      }
      i = j;
      continue;
    }

    // Number literal
    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < len && /[0-9]/.test(s[i + 1]))) {
      let j = i;
      while (j < len && /[0-9.]/.test(s[j])) j++;
      if (j < len && (s[j] === 'e' || s[j] === 'E')) {
        let k = j + 1;
        if (k < len && (s[k] === '+' || s[k] === '-')) k++;
        if (k < len && /[0-9]/.test(s[k])) {
          j = k;
          while (j < len && /[0-9]/.test(s[j])) j++;
        }
      }
      const numStr = s.slice(i, j);
      if (!Number.isFinite(Number(numStr))) diagnostics?.push({ kind: 'syntax', reason: `Invalid number ${numStr}` });
      tokens.push({ type: 'num', value: Number(numStr), raw: numStr });
      i = j;
      continue;
    }

    // Identifier (function name or bare identifier)
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_.]/.test(s[j])) j++;
      tokens.push({ type: 'ident', value: s.slice(i, j) });
      i = j;
      continue;
    }

    if ('+-*/%(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    diagnostics?.push({ kind: 'syntax', reason: `Unsupported character ${ch}` });
    i++;
  }
  return tokens;
}

export function parseExprAst(src, diagnostics = null) {
  const tokens = tokenizeExpr(src, diagnostics);
  if (tokens.length === 0) return { type: 'num', value: 0 };
  let pos = 0;

  function peek() {
    return tokens[pos] || null;
  }

  function consume() {
    return tokens[pos++];
  }

  function parseAdd() {
    let left = parseMul();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseMul();
      left = { type: 'bin', op, left, right };
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      const right = parseUnary();
      left = { type: 'bin', op, left, right };
    }
    return left;
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && (peek().value === '-' || peek().value === '+')) {
      const op = consume().value;
      const arg = parseUnary();
      if (op === '+') return arg;
      return { type: 'unary', op: '-', arg };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) {
      diagnostics?.push({ kind: 'syntax', reason: 'Expected a value' });
      return { type: 'num', value: 0 };
    }

    if (tok.type === 'num') {
      consume();
      return { type: 'num', value: tok.value };
    }
    if (tok.type === 'str') {
      consume();
      return { type: 'str', value: tok.value };
    }
    if (tok.type === 'var') {
      consume();
      return { type: 'var', kind: tok.kind, name: tok.name };
    }
    if (tok.type === 'ident') {
      consume();
      if (peek() && peek().type === 'op' && peek().value === '(') {
        consume(); // '('
        if (!Object.hasOwn(FUNCTIONS, tok.value)) {
          diagnostics?.push({ kind: 'unsupported_function', reason: tok.value });
        }
        const args = [];
        while (peek() && !(peek().type === 'op' && peek().value === ')')) {
          args.push(parseAdd());
          if (peek() && peek().type === 'op' && peek().value === ',') {
            consume();
          } else {
            break;
          }
        }
        if (peek() && peek().type === 'op' && peek().value === ')') consume();
        else diagnostics?.push({ kind: 'syntax', reason: 'Expected closing parenthesis' });
        return { type: 'call', name: tok.value, args };
      }
      if (tok.value === 'true') return { type: 'num', value: 1 };
      if (tok.value === 'false') return { type: 'num', value: 0 };
      return { type: 'str', value: tok.value };
    }
    if (tok.type === 'op' && tok.value === '(') {
      consume();
      const inner = parseAdd();
      if (peek() && peek().type === 'op' && peek().value === ')') consume();
      else diagnostics?.push({ kind: 'syntax', reason: 'Expected closing parenthesis' });
      return inner;
    }

    diagnostics?.push({ kind: 'syntax', reason: `Unexpected token ${tok.value}` });
    consume();
    return { type: 'num', value: 0 };
  }

  const ast = parseAdd();
  if (peek()) diagnostics?.push({ kind: 'syntax', reason: `Trailing token ${peek().value}` });
  return ast;
}

export function inspectExpression(expr) {
  const diagnostics = [];
  parseExprAst(expr, diagnostics);
  return diagnostics;
}

export function evalAst(ast, ctx) {
  if (!ast) return 0;
  switch (ast.type) {
    case 'num':
      return ast.value;
    case 'str':
      return ast.value;
    case 'var': {
      if (ctx && typeof ctx.getVar === 'function') {
        return ctx.getVar(ast.name, ast.kind);
      }
      if (ctx && ast.name in ctx) {
        return ctx[ast.name];
      }
      return ast.kind === '@' ? '' : 0;
    }
    case 'unary': {
      const v = Number(evalAst(ast.arg, ctx));
      return Number.isFinite(v) ? -v : 0;
    }
    case 'bin': {
      const l = evalAst(ast.left, ctx);
      const r = evalAst(ast.right, ctx);
      if (ast.op === '+') {
        if (typeof l === 'string' || typeof r === 'string') {
          return String(l ?? '') + String(r ?? '');
        }
        const res = (Number(l) || 0) + (Number(r) || 0);
        return Number.isFinite(res) ? res : 0;
      }
      const nl = Number(l) || 0;
      const nr = Number(r) || 0;
      if (ast.op === '-') return nl - nr;
      if (ast.op === '*') return nl * nr;
      if (ast.op === '/') return nr === 0 ? 0 : nl / nr;
      if (ast.op === '%') return nr === 0 ? 0 : nl % nr;
      return 0;
    }
    case 'call': {
      const fn = Object.hasOwn(FUNCTIONS, ast.name) ? FUNCTIONS[ast.name] : null;
      const args = ast.args.map(a => evalAst(a, ctx));
      if (fn) {
        const res = fn(...args);
        if (typeof res === 'number' && !Number.isFinite(res)) return 0;
        return res;
      }
      return 0;
    }
    default:
      return 0;
  }
}

export function evalExpr(exprStr, ctx) {
  if (exprStr === undefined || exprStr === null || exprStr === '') return 0;
  if (typeof exprStr === 'number') return exprStr;
  const trimmed = String(exprStr).trim();
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) {
    return Number(trimmed);
  }
  const ast = parseExprAst(trimmed);
  return evalAst(ast, ctx);
}

export function astCollectVars(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.type === 'var') {
    out.add(ast.name);
  } else if (ast.type === 'unary') {
    astCollectVars(ast.arg, out);
  } else if (ast.type === 'bin') {
    astCollectVars(ast.left, out);
    astCollectVars(ast.right, out);
  } else if (ast.type === 'call') {
    for (const a of ast.args) astCollectVars(a, out);
  }
  return out;
}

export function astToString(ast) {
  if (!ast) return '0';
  switch (ast.type) {
    case 'num':
      return formatNum(ast.value);
    case 'str':
      return `'${String(ast.value).replace(/'/g, "\\'")}'`;
    case 'var':
      return `${ast.kind}${ast.name}`;
    case 'unary':
      return `-${wrapIfNeeded(ast.arg, 3)}`;
    case 'bin': {
      const prec = ast.op === '+' || ast.op === '-' ? 1 : 2;
      const l = wrapIfNeeded(ast.left, prec);
      const rPrec = ast.op === '-' || ast.op === '/' || ast.op === '%' ? prec + 1 : prec;
      const r = wrapIfNeeded(ast.right, rPrec);
      return `${l}${ast.op}${r}`;
    }
    case 'call':
      return `${ast.name}(${ast.args.map(a => astToString(a)).join(',')})`;
    default:
      return '0';
  }
}

function wrapIfNeeded(node, parentPrec) {
  if (!node) return '0';
  if (node.type === 'bin') {
    const myPrec = node.op === '+' || node.op === '-' ? 1 : 2;
    const s = astToString(node);
    return myPrec < parentPrec ? `(${s})` : s;
  }
  if (node.type === 'unary' && parentPrec >= 3) {
    return `(${astToString(node)})`;
  }
  return astToString(node);
}

export function formatNum(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  const rounded = Math.round(num * 1000) / 1000;
  if (Object.is(rounded, -0)) return '0';
  return String(rounded);
}

const SCREEN_BASE_VARS = new Set(['screen_width', 'screen_height', 'view_width', 'view_height']);

const RUNTIME_MEASURED_SUFFIXES = ['.actual_w', '.actual_h', '.text_width', '.text_height'];

function isRuntimeMeasuredVar(name) {
  return RUNTIME_MEASURED_SUFFIXES.some(suf => name.endsWith(suf));
}

function isBitmapMetricVar(name) {
  return name.endsWith('.bmp_width') || name.endsWith('.bmp_height');
}

/**
 * Analyze all <Var> / <VarArray> / <VariableAnimation> / <Weather> / <Healthy> declarations
 * and classify variables into: pure_const, screen_derived, dynamic, mixed.
 */
export function buildRuntimeContext(root, screenW, screenH, overrides = {}, assetIndex = null) {
  const vars = new Map();
  const varMeta = new Map(); // name -> { depClass: 'pure_const'|'screen_derived'|'dynamic'|'mixed', exprAst, rawExpr }

  // Seed system variables
  const systemDefaults = {
    screen_width: screenW,
    screen_height: screenH,
    view_width: screenW,
    view_height: screenH,
    hour12: 10,
    hour24: 10,
    hour: 10,
    minute: 8,
    second: 30,
    year: 2026,
    month: 10, // 0-indexed (10 => Nov)
    date: 22,
    day_of_week: 1,
    ampm: 0,
    time: 5000,
    time_sys: 1795352880000,
    battery_level: 85,
    battery_state: 0,
    charge_anim: 0,
    charge_level: '85.0',
    charge_type_value: 1,
    charge_mode_value: 3,
    charge_max_power: 66,
    charge_power_value: 66,
    flashlight: 0,
    flashlightValue: 0,
    media_play_status: 0,
    media_title: 'Theme Audio',
    media_subtitle: 'Huawei Music',
    steps_value: 6500,
    step: 6500,
    steps: 6500,
    touch_x: 540,
    touch_y: 1200,
    touch_begin_x: 540,
    touch_begin_y: 1200,
    ishour12: 0,
    'system.time.hour1': 1,
    'system.time.hour2': 0,
    'system.time.min1': 0,
    'system.time.min2': 8,
    'Weather.today.currentTem': 24,
    'Weather.today.mintemp': 16,
    'Weather.today.maxtemp': 26,
    'Weather.today.weatherIcon': 1,
    'Weather.today.weatherIconDes': '晴',
    'Weather.today.aqivalue': 25,
    'Weather.today.aqivaluetext': '优',
    'Weather.today.humidity': 45,
    'Weather.today.winddirDes': '微风',
    'Weather.today.sunRise': '06:30',
    'Weather.today.sunSet': '17:45',
  };

  for (const [k, v] of Object.entries(systemDefaults)) {
    vars.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    vars.set(k, v);
  }

  const varDecls = [];
  const varArrays = [];
  const weatherDefaults = [];
  const elementNames = new Map(); // name -> node
  const mutatedVarNames = new Set();
  const cmdExprsByVar = new Map();

  function scanDecls(node, insideInitOnly = false) {
    if (!node || node.type !== 'element') return;
    if (node.attrs && node.attrs.name) {
      elementNames.set(node.attrs.name, node);
    }
    const t = node.tagLower;
    if (t === 'variablecommand' && node.attrs.name && !insideInitOnly) {
      mutatedVarNames.add(node.attrs.name);
      if (!cmdExprsByVar.has(node.attrs.name)) cmdExprsByVar.set(node.attrs.name, new Set());
      cmdExprsByVar.get(node.attrs.name).add(String(node.attrs.expression ?? '').trim());
    }
    if (t === 'var' && node.attrs.name && !insideInitOnly && t !== 'trigger' && t !== 'triggers') {
      // Check if it has VariableAnimation child
      const anim = node.children.find(c => c.type === 'element' && c.tagLower === 'variableanimation');
      varDecls.push({ node, anim });
    } else if (t === 'vararray' && !insideInitOnly) {
      varArrays.push(node);
    } else if (t === 'weather') {
      for (const c of node.children) {
        if (c.type === 'element' && c.tagLower === 'var' && c.attrs.name) {
          weatherDefaults.push(c);
        }
      }
      return; // don't treat Weather children as regular dynamic VarDecls overriding system weather unless needed
    }
    const nextInitOnly = insideInitOnly || t === 'externalcommands';
    for (const c of node.children) {
      scanDecls(c, nextInitOnly);
    }
  }
  scanDecls(root, false);

  // Seed Weather fallback vars only if not already in systemDefaults
  for (const wv of weatherDefaults) {
    const nm = wv.attrs.name;
    if (!vars.has(nm) && wv.attrs.expression !== undefined) {
      vars.set(nm, evalExpr(wv.attrs.expression, ctxProxy()));
    }
  }

  const resolvingMetrics = new Set();

  function ctxProxy() {
    return {
      getVar(name, kind) {
        if (vars.has(name)) return vars.get(name);
        if (isRuntimeMeasuredVar(name) || isBitmapMetricVar(name)) {
          if (resolvingMetrics.has(name)) return 80;
          resolvingMetrics.add(name);
          try {
            const dot = name.lastIndexOf('.');
            const baseName = name.slice(0, dot);
            const prop = name.slice(dot + 1);
            const refNode = elementNames.get(baseName);
            if (refNode) {
              if (prop === 'text_width' || prop === 'text_height') {
                const sz = refNode.attrs.size !== undefined ? Number(evalExpr(refNode.attrs.size, ctxProxy())) || 40 : 40;
                if (prop === 'text_height') return sz * 1.25;
                const txt = refNode.attrs.text || (refNode.attrs.textExp ? String(evalExpr(refNode.attrs.textExp, ctxProxy()) || '10:08') : '10:08');
                let estW = 0;
                for (const ch of txt) estW += ch.charCodeAt(0) > 127 ? sz * 1.02 : sz * 0.58;
                return Math.max(sz * 1.2, estW);
              }
              if (prop === 'actual_w' || prop === 'bmp_width') {
                if (refNode.attrs.w !== undefined) {
                  return (Number(evalExpr(refNode.attrs.w, ctxProxy()))) || 80;
                }
                if ((refNode.tagLower === 'imagenumber' || refNode.tagLower === 'imageseries') && refNode.attrs.src) {
                  const resAsset = assetIndex ? assetIndex.resolveImageAsset({ src: refNode.attrs.src, srcid: '0' }) : null;
                  const dims = resAsset && assetIndex ? assetIndex.getDimensions(resAsset) : null;
                  const gw = dims ? dims.width : 48;
                  const sp = Number(evalExpr(refNode.attrs.space ?? 0, ctxProxy())) || 0;
                  let str = '88';
                  if (refNode.tagLower === 'imagenumber' && refNode.attrs.number !== undefined) {
                    str = String(Math.trunc(Number(evalExpr(refNode.attrs.number, ctxProxy())) || 88));
                  } else if (refNode.tagLower === 'imageseries' && refNode.attrs.string !== undefined) {
                    const val = String(evalExpr(refNode.attrs.string, ctxProxy()) || '88');
                    str = val.length > 0 ? val : '88';
                  }
                  const n = Math.max(1, str.length);
                  return n * gw + Math.max(0, n - 1) * sp;
                }
                return 80;
              }
              if (prop === 'actual_h' || prop === 'bmp_height') {
                if (refNode.attrs.h !== undefined) {
                  return (Number(evalExpr(refNode.attrs.h, ctxProxy()))) || 80;
                }
                if ((refNode.tagLower === 'imagenumber' || refNode.tagLower === 'imageseries') && refNode.attrs.src) {
                  const resAsset = assetIndex ? assetIndex.resolveImageAsset({ src: refNode.attrs.src, srcid: '0' }) : null;
                  const dims = resAsset && assetIndex ? assetIndex.getDimensions(resAsset) : null;
                  return dims ? dims.height : 72;
                }
                return 80;
              }
            }
            return 0;
          } finally {
            resolvingMetrics.delete(name);
          }
        }
        return kind === '@' ? '' : 0;
      },
    };
  }

  function classifyVarDeps(ast) {
    const refs = astCollectVars(ast);
    let hasScreen = false;
    let hasDynamic = false;
    for (const r of refs) {
      if (SCREEN_BASE_VARS.has(r)) {
        hasScreen = true;
      } else if (varMeta.has(r)) {
        const dc = varMeta.get(r).depClass;
        if (dc === 'screen_derived') hasScreen = true;
        else if (dc === 'dynamic') hasDynamic = true;
        else if (dc === 'mixed') {
          hasScreen = true;
          hasDynamic = true;
        }
      } else {
        // System time/weather/touch/state/element-metric vars are dynamic
        hasDynamic = true;
      }
    }
    if (hasScreen && hasDynamic) return 'mixed';
    if (hasScreen) return 'screen_derived';
    if (hasDynamic) return 'dynamic';
    return 'pure_const';
  }

  // Evaluate Var declarations in document order
  for (const { node, anim } of varDecls) {
    const name = node.attrs.name;
    if (name in overrides) {
      vars.set(name, overrides[name]);
      varMeta.set(name, { depClass: 'dynamic', rawExpr: node.attrs.expression || '0', ast: null });
      continue;
    }
    if (anim) {
      // VariableAnimation: steady end value is last AniFrame with finite value, or first if time=0
      const frames = anim.children.filter(c => c.type === 'element' && c.tagLower === 'aniframe');
      let val = 0;
      if (frames.length > 0) {
        // Prefer frame at reasonable settled time (e.g., last frame unless value >= 999999)
        const settled = frames.find(f => Number(f.attrs.time) >= 500 && Number(f.attrs.time) < 100000) || frames[frames.length - 1];
        const rawVal = settled.attrs.value ?? '0';
        const v = evalExpr(rawVal, ctxProxy());
        val = Number.isFinite(Number(v)) && Math.abs(Number(v)) < 1e7 ? v : evalExpr(frames[0].attrs.value ?? '0', ctxProxy());
      }
      vars.set(name, val);
      varMeta.set(name, { depClass: 'dynamic', rawExpr: String(val), ast: null });
      continue;
    }

    const rawExpr = node.attrs.expression;
    if (rawExpr !== undefined) {
      const ast = parseExprAst(rawExpr);
      let val = evalAst(ast, ctxProxy());
      if (node.attrs.type !== 'string' && typeof val === 'string' && !rawExpr.includes("'") && !rawExpr.includes('@')) {
        const n = Number(val);
        val = Number.isFinite(n) ? n : 0;
      }
      vars.set(name, val);
      let depClass = classifyVarDeps(ast);
      const isSameScreenFormulaOnly =
        depClass === 'screen_derived' &&
        rawExpr &&
        cmdExprsByVar.has(name) &&
        [...cmdExprsByVar.get(name)].every(ce => ce === String(rawExpr).trim());
      if (isSameScreenFormulaOnly) {
        mutatedVarNames.delete(name);
      } else if (node.attrs.threshold !== undefined || mutatedVarNames.has(name)) {
        depClass = 'dynamic';
      }
      varMeta.set(name, { depClass, rawExpr, ast });
    } else if (!vars.has(name)) {
      vars.set(name, node.attrs.type === 'string' ? '' : 0);
      varMeta.set(name, { depClass: 'dynamic', rawExpr: '', ast: null });
    }
  }

  // Evaluate VarArray elements
  for (const va of varArrays) {
    const type = va.attrs.type || 'number';
    const varsNode = va.children.find(c => c.type === 'element' && c.tagLower === 'vars');
    const itemsNode = va.children.find(c => c.type === 'element' && c.tagLower === 'items');
    if (!varsNode || !itemsNode) continue;
    const items = itemsNode.children
      .filter(c => c.type === 'element' && c.tagLower === 'item')
      .map(c => c.attrs.value ?? '');
    for (const v of varsNode.children) {
      if (v.type !== 'element' || v.tagLower !== 'var' || !v.attrs.name) continue;
      const idxRaw = evalExpr(v.attrs.index ?? '0', ctxProxy());
      const idx = Math.max(0, Math.min(items.length - 1, Math.trunc(Number(idxRaw) || 0)));
      const itemVal = items[idx] ?? (type === 'string' ? '' : 0);
      const finalVal = type === 'string'
        ? (itemVal.startsWith('@') || itemVal.startsWith('#') || itemVal.includes('+') ? String(evalExpr(itemVal, ctxProxy())) : itemVal)
        : evalExpr(itemVal, ctxProxy());
      vars.set(v.attrs.name, finalVal);
      varMeta.set(v.attrs.name, { depClass: 'dynamic', rawExpr: itemVal, ast: null });
    }
  }

  // Also ensure guide defaults to 0 during main snapshot unless explicitly overridden
  if (!('guide' in overrides) && vars.has('guide')) {
    // Keep track of original guide var but allow scene simulation overrides cleanly
  }

  const proxy = ctxProxy();
  proxy.vars = vars;
  proxy.varMeta = varMeta;
  proxy.mutatedVarNames = mutatedVarNames;
  proxy.classifyExpr = (exprStr) => {
    if (exprStr === undefined || exprStr === null || exprStr === '') return 'pure_const';
    const ast = parseExprAst(String(exprStr));
    return classifyVarDeps(ast);
  };
  proxy.eval = (exprStr) => evalExpr(exprStr, proxy);
  return proxy;
}

/**
 * Rewrite an attribute expression AST for a target linear transform:
 *   newVal = offsetExpr + (val_in_ref) * scaleExpr   (when !isSize)
 *   newVal = (val_in_ref) * scaleExpr                (when isSize)
 */
export function rewriteExprForTransform({
  exprStr,
  ctx,
  scaleExpr,
  offsetExpr = '0',
  isSize = false,
}) {
  if (exprStr === undefined || exprStr === null || exprStr === '') return null;
  const trimmed = String(exprStr).trim();
  const ast = parseExprAst(trimmed);
  const depClass = ctx.classifyExpr(trimmed);

  const hasOffset = offsetExpr && offsetExpr !== '0' && offsetExpr !== 0;

  // 1. Pure const or screen_derived -> evaluate exact numeric value in reference canvas!
  if (depClass === 'pure_const' || depClass === 'screen_derived') {
    const v0 = Number(evalAst(ast, ctx));
    const safeV0 = Number.isFinite(v0) ? v0 : 0;
    return buildLinearExpr(safeV0, scaleExpr, isSize ? null : offsetExpr);
  }

  // 2. Dynamic / Mixed: check if this is a fullscreen paging expression like `#w*(1-#oneSec)` or `#screen_width*#page`
  if (!isSize && isFullscreenPagingExpr(ast, ctx)) {
    return rewritePagingExpr(ast, ctx, scaleExpr, offsetExpr);
  }

  // 3. Dynamic / Mixed general rewrite:
  // Freeze screen_derived variables to their reference scalar values, and apply scaleExpr cleanly.
  const frozenAst = freezeScreenVars(ast, ctx);
  const scaledExpr = scaleDynamicAst(frozenAst, scaleExpr);
  if (!isSize && hasOffset) {
    return combineOffsetAndTerm(offsetExpr, scaledExpr);
  }
  return scaledExpr;
}

function buildLinearExpr(v0, scaleExpr, offsetExpr) {
  const vStr = formatNum(v0);
  const hasOffset = offsetExpr !== null && offsetExpr !== undefined && offsetExpr !== '0' && offsetExpr !== 0;
  if (v0 === 0) {
    return hasOffset ? String(offsetExpr) : '0';
  }
  const scaledPart = scaleExpr === '1'
    ? vStr
    : (v0 === 1 ? String(scaleExpr) : (v0 === -1 ? `-${wrapAtom(scaleExpr)}` : `${vStr}*${wrapAtom(scaleExpr)}`));
  if (!hasOffset) return scaledPart;
  if (v0 < 0) {
    const absScaled = scaleExpr === '1'
      ? formatNum(-v0)
      : (-v0 === 1 ? String(scaleExpr) : `${formatNum(-v0)}*${wrapAtom(scaleExpr)}`);
    return `${offsetExpr}-${absScaled}`;
  }
  return `${offsetExpr}+${scaledPart}`;
}

function wrapAtom(expr) {
  const s = String(expr);
  if (/^[A-Za-z0-9_#.]+$/.test(s)) return s;
  return `(${s})`;
}

function combineOffsetAndTerm(offsetExpr, termExpr) {
  if (!offsetExpr || offsetExpr === '0') return termExpr;
  if (!termExpr || termExpr === '0') return String(offsetExpr);
  if (termExpr.startsWith('-')) return `${offsetExpr}${termExpr}`;
  return `${offsetExpr}+${termExpr}`;
}

function isScreenWidthDerived(ast, ctx) {
  if (!ast) return false;
  if (ast.type === 'var') {
    if (ast.name === 'screen_width' || ast.name === 'view_width') return true;
    const meta = ctx.varMeta.get(ast.name);
    if (meta && meta.depClass === 'screen_derived') {
      const refs = astCollectVars(meta.ast);
      return refs.has('screen_width') || refs.has('view_width') || ast.name === 'w' || ast.name === 'sw' || ast.name === 'ysw';
    }
  }
  return false;
}

function isFullscreenPagingExpr(ast, ctx) {
  // Detects patterns like `#w*(1-#oneSec)` or `#screen_width*#page` at top level
  if (!ast) return false;
  if (ast.type === 'bin' && ast.op === '*') {
    if (isScreenWidthDerived(ast.left, ctx) || isScreenWidthDerived(ast.right, ctx)) {
      return true;
    }
  }
  if (ast.type === 'bin' && (ast.op === '+' || ast.op === '-')) {
    return isFullscreenPagingExpr(ast.left, ctx) || isFullscreenPagingExpr(ast.right, ctx);
  }
  return false;
}

function rewritePagingExpr(ast, ctx, scaleExpr, offsetExpr) {
  // Split into additive terms; keep paging term using `#screen_width`, scale other terms
  const terms = splitAdditiveTerms(ast);
  const parts = [];
  if (offsetExpr && offsetExpr !== '0') parts.push(String(offsetExpr));

  for (const { sign, node } of terms) {
    if (isFullscreenPagingExpr(node, ctx)) {
      const replaced = replaceScreenWidthVar(node, ctx);
      const s = astToString(replaced);
      parts.push(sign < 0 ? `-(${s})` : `+${s}`);
    } else {
      const frozen = freezeScreenVars(node, ctx);
      const dep = ctx.classifyExpr(astToString(node));
      if (dep === 'pure_const' || dep === 'screen_derived') {
        const v0 = Number(evalAst(node, ctx)) * sign;
        if (v0 !== 0) {
          const termStr = buildLinearExpr(v0, scaleExpr, null);
          parts.push(v0 < 0 ? termStr : `+${termStr}`);
        }
      } else {
        const scaled = scaleDynamicAst(frozen, scaleExpr);
        parts.push(sign < 0 ? `-(${scaled})` : `+${scaled}`);
      }
    }
  }
  let res = parts.join('');
  if (res.startsWith('+')) res = res.slice(1);
  return res || '0';
}

function replaceScreenWidthVar(ast, ctx) {
  if (!ast) return ast;
  if (ast.type === 'var' && isScreenWidthDerived(ast, ctx)) {
    return { type: 'var', kind: '#', name: 'screen_width' };
  }
  if (ast.type === 'unary') return { type: 'unary', op: ast.op, arg: replaceScreenWidthVar(ast.arg, ctx) };
  if (ast.type === 'bin') {
    return { type: 'bin', op: ast.op, left: replaceScreenWidthVar(ast.left, ctx), right: replaceScreenWidthVar(ast.right, ctx) };
  }
  if (ast.type === 'call') return { type: 'call', name: ast.name, args: ast.args.map(a => replaceScreenWidthVar(a, ctx)) };
  return ast;
}

export function freezeScreenVarsExpr(exprStr, ctx) {
  if (exprStr === undefined || exprStr === null || exprStr === '') return '0';
  const ast = parseExprAst(exprStr);
  return astToString(freezeScreenVars(ast, ctx));
}

export function evalSettledExpr(exprStr, ctx) {
  if (exprStr === undefined || exprStr === null || exprStr === '') return 0;
  const ast = parseExprAst(exprStr);
  const refs = astCollectVars(ast);
  const settledCtx = {
    getVar(name, kind) {
      if (kind !== '@' && refs.has(name) && !name.startsWith('__hw_') && !SCREEN_BASE_VARS.has(name)) {
        const meta = ctx.varMeta.get(name);
        if (!meta || meta.depClass === 'dynamic' || meta.depClass === 'mixed') {
          const cur = ctx.getVar(name, kind);
          if (cur === 0 || cur === '0') return 1;
        }
      }
      return ctx.getVar(name, kind);
    },
  };
  return Number(evalAst(ast, settledCtx));
}

export function evalOpenSlideExpr(exprStr, ctx, axisLo, axisHi) {
  if (exprStr === undefined || exprStr === null || exprStr === '') return null;
  const ast = parseExprAst(exprStr);
  const v0 = Number(evalAst(ast, ctx));
  const refs = [...astCollectVars(ast)];
  const inRange = (v) => Number.isFinite(v) && v >= axisLo && v <= axisHi && Math.abs(v - v0) >= 80;

  // Dynamic referenced variables (non-screen, non-__hw_)
  const dynRefs = refs.filter(r => {
    if (r.startsWith('__hw_') || SCREEN_BASE_VARS.has(r)) return false;
    const meta = ctx.varMeta.get(r);
    return !meta || meta.depClass === 'dynamic' || meta.depClass === 'mixed';
  });

  // Try 1: 0 -> 1 animation settle (e.g. 57 + 650*(#zy - 1) -> 57)
  const overrides1 = {};
  for (const r of dynRefs) {
    const cur = ctx.getVar(r, '#');
    if (cur === 0 || cur === '0') overrides1[r] = 1;
  }
  const v1 = Number(evalAst(ast, {
    getVar(name, kind) {
      if (kind !== '@' && name in overrides1) return overrides1[name];
      return ctx.getVar(name, kind);
    },
  }));
  if (inRange(v1)) return { val: v1, method: 'settled_1', overrides: overrides1 };

  if (dynRefs.length === 0) return null;

  // Try 2: all dynamic vars -> 0 (e.g. #hm_yh + 672 + #penal_y_all -> #hm_yh + 672)
  const overridesZero = {};
  for (const r of dynRefs) overridesZero[r] = 0;
  const vZero = Number(evalAst(ast, {
    getVar(name, kind) {
      if (kind !== '@' && name in overridesZero) return 0;
      return ctx.getVar(name, kind);
    },
  }));
  if (inRange(vZero)) return { val: vZero, method: 'zero_dyn', overrides: overridesZero };

  // Try 3: single dynamic var set to pi/2 (sin() slides) or 1 or 0
  for (const candVar of dynRefs) {
    for (const testVal of [Math.PI / 2, 1, 0]) {
      const vc = Number(evalAst(ast, {
        getVar(name, kind) {
          if (kind !== '@' && name === candVar) return testVal;
          return ctx.getVar(name, kind);
        },
      }));
      if (inRange(vc)) return { val: vc, method: 'single_var', overrides: { [candVar]: testVal } };
    }
  }
  return null;
}

function freezeScreenVars(ast, ctx) {
  if (!ast) return ast;
  if (ast.type === 'var') {
    if (SCREEN_BASE_VARS.has(ast.name)) {
      return { type: 'num', value: Number(ctx.getVar(ast.name, ast.kind)) || 0 };
    }
    const meta = ctx.varMeta.get(ast.name);
    if (meta && meta.depClass === 'screen_derived') {
      return { type: 'num', value: Number(ctx.getVar(ast.name, ast.kind)) || 0 };
    }
    if (meta && meta.depClass === 'mixed' && meta.ast) {
      return freezeScreenVars(meta.ast, ctx);
    }
    return ast;
  }
  if (ast.type === 'unary') return { type: 'unary', op: ast.op, arg: freezeScreenVars(ast.arg, ctx) };
  if (ast.type === 'bin') {
    return { type: 'bin', op: ast.op, left: freezeScreenVars(ast.left, ctx), right: freezeScreenVars(ast.right, ctx) };
  }
  if (ast.type === 'call') return { type: 'call', name: ast.name, args: ast.args.map(a => freezeScreenVars(a, ctx)) };
  return ast;
}

function splitAdditiveTerms(ast, sign = 1, out = []) {
  if (!ast) return out;
  if (ast.type === 'bin' && ast.op === '+') {
    splitAdditiveTerms(ast.left, sign, out);
    splitAdditiveTerms(ast.right, sign, out);
  } else if (ast.type === 'bin' && ast.op === '-') {
    splitAdditiveTerms(ast.left, sign, out);
    splitAdditiveTerms(ast.right, -sign, out);
  } else {
    out.push({ sign, node: ast });
  }
  return out;
}

function containsRuntimeMeasuredVar(ast) {
  const vars = astCollectVars(ast);
  for (const v of vars) {
    if (isRuntimeMeasuredVar(v)) return true;
  }
  return false;
}

function scaleDynamicAst(ast, scaleExpr) {
  if (scaleExpr === '1') return astToString(ast);
  const terms = splitAdditiveTerms(ast);
  let unscaledParts = [];
  let runtimeParts = [];

  for (const { sign, node } of terms) {
    const s = astToString(node);
    const hasRuntime = containsRuntimeMeasuredVar(node);
    const needsParens = node.type === 'bin' && (node.op === '+' || node.op === '-');
    const wrapped = needsParens ? `(${s})` : s;
    const signedStr = sign < 0 ? `-${wrapped}` : (unscaledParts.length || runtimeParts.length ? `+${wrapped}` : wrapped);

    if (hasRuntime) {
      // Terms referencing .actual_w / .text_width are ALREADY in runtime-scaled px
      runtimeParts.push({ sign, str: wrapped });
    } else {
      unscaledParts.push({ sign, node, str: wrapped });
    }
  }

  let result = '';
  if (unscaledParts.length > 0) {
    const sumStr = unscaledParts.map((p, idx) => {
      if (idx === 0) return p.sign < 0 ? `-${p.str}` : p.str;
      return p.sign < 0 ? `-${p.str}` : `+${p.str}`;
    }).join('');
    if (unscaledParts.length === 1 && unscaledParts[0].node.type === 'num') {
      const val = unscaledParts[0].node.value * unscaledParts[0].sign;
      result = val === 0 ? '' : `${formatNum(val)}*${wrapAtom(scaleExpr)}`;
    } else {
      const inner = unscaledParts.length === 1 && unscaledParts[0].sign > 0 && unscaledParts[0].node.type !== 'bin'
        ? unscaledParts[0].str
        : `(${sumStr})`;
      result = `${inner}*${wrapAtom(scaleExpr)}`;
    }
  }

  for (const rp of runtimeParts) {
    if (!result) {
      result = rp.sign < 0 ? `-${rp.str}` : rp.str;
    } else {
      result += rp.sign < 0 ? `-${rp.str}` : `+${rp.str}`;
    }
  }

  return result || '0';
}
