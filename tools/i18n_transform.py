#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""تحويل نصوص الواجهة العربية داخل مكوّنات React إلى t()/tx() تلقائيًا."""
import json, re, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAIRS = os.path.join(ROOT, "src/i18n/pairs.json")
AR = re.compile(r"[\u0600-\u06FF]")
MAX_JSX = 90

FILES = [
    "src/App.tsx",
    "src/components/Navbar.tsx",
    "src/components/Hero.tsx",
    "src/components/Extras.tsx",
    "src/components/Guarantees.tsx",
    "src/components/ChatDemo.tsx",
    "src/components/ChannelsSection.tsx",
    "src/components/Pricing.tsx",
    "src/components/FAQ.tsx",
    "src/components/WidgetEditor.tsx",
    "src/components/WidgetPreview.tsx",
    "src/pages/Dashboard.tsx",
    "src/pages/Widgets.tsx",
]

def skip_region(src, i):
    two = src[i:i+2]
    if two == "//":
        j = src.find("\n", i)
        return len(src) if j < 0 else j
    if two == "/*":
        j = src.find("*/", i + 2)
        return len(src) if j < 0 else j + 2
    if src[i] in "\"'":
        q = src[i]; j = i + 1
        while j < len(src) and src[j] != q:
            j += 2 if src[j] == "\\" else 1
        return min(j + 1, len(src))
    if src[i] == "`":
        j = i + 1
        while j < len(src):
            if src[j] == "\\": j += 2; continue
            if src[j] == "`": return j + 1
            if src.startswith("${", j):
                depth = 1; k = j + 2
                while k < len(src) and depth:
                    c = src[k]
                    if c == "{": depth += 1
                    elif c == "}": depth -= 1
                    elif c in "\"'`":
                        e = skip_region(src, k)
                        if e is None: k += 1; continue
                        k = e - 1
                    k += 1
                j = k; continue
            j += 1
        return len(src)
    return None

def code_positions(src):
    pos = set(); i = 0; n = len(src)
    while i < n:
        e = skip_region(src, i)
        if e is None:
            pos.add(i); i += 1
        else:
            i = e
    return pos

class Src:
    def __init__(self, text):
        self.s = text
        self.code = code_positions(text)
    def find_matching(self, open_idx, o="{", c="}"):
        depth = 0; i = open_idx; n = len(self.s)
        while i < n:
            if i in self.code:
                ch = self.s[i]
                if ch == o: depth += 1
                elif ch == c:
                    depth -= 1
                    if depth == 0: return i
            i += 1
        return n - 1

def parse_tpl(S, i):
    src = S.s
    j = i + 1
    parts = []; seg = ""
    while j < len(src):
        if src[j] == "\\":
            seg += src[j:j+2]; j += 2; continue
        if src[j] == "`":
            break
        if src.startswith("${", j):
            close = S.find_matching(j + 1)
            parts.append(seg); seg = ""
            parts.append(("EXPR", src[j+2:close]))
            j = close + 1; continue
        seg += src[j]; j += 1
    parts.append(seg)
    return parts, j + 1

FN_PAT = re.compile(
    r"(?:export\s+default\s+function|export\s+function|function)\s+([A-Za-z_$][\w$]*)"
    r"|(?:(export)\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\b|\([^)\n]*\)\s*(?::[^=\n{]+)?=>|[A-Za-z_$][\w$]*\s*=>)"
)

def fn_name(m):
    return m.group(1) or m.group(3) or ""

def _skip_ws(src, S, k):
    n = len(src)
    while k < n:
        if src[k] in " \t\r\n": k += 1; continue
        if k not in S.code:
            e = skip_region(src, k)
            k = e if e is not None else k + 1
            continue
        break
    return k

def _scan_paren(S, k):
    """src[k]=='(' -> index after matching ')'"""
    src = S.s; depth = 0; i = k; n = len(src)
    while i < n:
        if i in S.code:
            if src[i] == "(": depth += 1
            elif src[i] == ")":
                depth -= 1
                if depth == 0: return i + 1
        i += 1
    return n

def _scan_bracket(S, k):
    src = S.s; depth = 0; i = k; n = len(src)
    while i < n:
        if i in S.code:
            if src[i] == "[": depth += 1
            elif src[i] == "]":
                depth -= 1
                if depth == 0: return i + 1
        i += 1
    return n

def parse_fn_at(S, start):
    """Try to parse a function definition beginning at `start` (code position).
       Returns (body_open_idx_or_expr_start, kind) where kind in ('block','expr') or None."""
    src = S.s; n = len(src); i = start
    kw = re.compile(r"(?:export\s+default\s+|export\s+|default\s+)")
    m = kw.match(src, i)
    if m: i = _skip_ws(src, S, m.end())
    m2 = re.match(r"async\s+", src[i:])
    if m2: i = _skip_ws(src, S, i + m2.end())
    m3 = re.match(r"function\s+", src[i:])
    if m3:
        i = _skip_ws(src, S, i + m3.end())
        mN = re.match(r"[A-Za-z_$][\w$]*", src[i:])
        if not mN: return None
        i = _skip_ws(src, S, i + mN.end())
        if i < n and src[i] == "<":
            gt = src.find(">", i)
            if gt < 0: return None
            i = _skip_ws(src, S, gt + 1)
    else:
        mC = re.match(r"(const|let)\s+([A-Za-z_$][\w$]*)\s*", src[i:])
        if mC:
            i += mC.end()
            # optional type annotation up to '='
            j = i; depth = 0
            while j < n:
                if j in S.code:
                    ch = src[j]
                    if ch in "(<[": depth += 1
                    elif ch in ")>]": depth -= 1
                    elif ch == "=" and depth == 0 and src[j:j+2] != "=>":
                        i = j + 1; break
                j += 1
            i = _skip_ws(src, S, i)
            m2 = re.match(r"async\s+", src[i:])
            if m2: i = _skip_ws(src, S, i + m2.end())
            m3 = re.match(r"function\b\s*", src[i:])
            if m3: i = _skip_ws(src, S, i + m3.end())
        elif not m3:
            return None
    # now expect params: '(' ... ')'  or ident '=>'
    if i < n and src[i] == "(":
        i = _skip_ws(src, S, _scan_paren(S, i))
    else:
        mN = re.match(r"[A-Za-z_$][\w$]*\s*=>", src[i:])
        if not mN: return None
        i = _skip_ws(src, S, i + mN.end(0) - 2)
        return (i, "arrow-noparen")
    # optional return type ": T" then => or {
    if i < n and src[i] == ":":
        j = i + 1; depth = 0
        while j < n:
            if j in S.code:
                ch = src[j]
                if ch in "(<[": depth += 1
                elif ch in ")>]": depth -= 1
                elif depth == 0 and (ch == "=" or ch == "{"):
                    break
            j += 1
        i = _skip_ws(src, S, j)
    if src.startswith("=>", i):
        i = _skip_ws(src, S, i + 2)
        if i < n and src[i] == "{":
            return (i, "block")
        return (i, "expr")
    if i < n and src[i] == "{":
        return (i, "block")
    return None

def component_ranges(S):
    """ranges covering bodies (or whole def region) of components (uppercase names)."""
    src = S.s
    ranges = []
    for m in FN_PAT.finditer(src):
        if not fn_name(m)[:1].isupper():
            continue
        res = parse_fn_at(S, m.start())
        if not res: continue
        k, kind = res
        if kind == "block":
            close = S.find_matching(k)
            ranges.append((k, close + 1))
        else:
            # expression body: extend until top-level ',' ';' or unbalanced close ends statement
            i = k; bal_p = 0; n = len(src)
            while i < n:
                if i in S.code:
                    ch = src[i]
                    if ch == "(": bal_p += 1
                    elif ch == ")":
                        if bal_p == 0: break
                        bal_p -= 1
                    elif ch in ";," and bal_p == 0:
                        break
                i += 1
            ranges.append((k, min(i + 1, n)))
    return ranges

def process_file(path, pairs, missing_new):
    src = open(path, encoding="utf-8").read()
    S = Src(src)
    comp_ranges = component_ranges(S)
    def in_comp(pos):
        return any(a <= pos < b for a, b in comp_ranges)
    ops = []; entries = []

    def key_for(s):
        s = s.strip()
        if not s or not AR.search(s): return None
        entries.append(s)
        if s not in pairs:
            missing_new.setdefault(os.path.relpath(path, ROOT), set()).add(s)
        return s

    def esc(v):
        return v.replace("\\", "\\\\").replace('"', '\\"')

    n = len(src); i = 0
    tag_stack = []
    while i < n:
        c = src[i]
        if c in "\"'" and i in S.code:
            e = skip_region(src, i)
            lit = src[i+1:e-1]
            if AR.search(lit) and "${" not in lit and len(lit) <= MAX_JSX * 4 and in_comp(i):
                k = key_for(lit)
                if k is not None:
                    ops.append((i, e, 't("%s")' % esc(k)))
            i = e; continue
        if c == "`" and i in S.code:
            parts, e = parse_tpl(S, i)
            statics = [p for p in parts if isinstance(p, str)]
            exprs = [p for p in parts if not isinstance(p, str)]
            joined = "".join(statics)
            has_ternary = any(isinstance(p, tuple) and "?" in p[1] for p in parts) or any(p.lstrip().startswith(":") for p in statics)
            if AR.search(joined) and not has_ternary and in_comp(i):
                no_expr = not exprs
                simple = all(re.fullmatch(r"[A-Za-z_$][\w$.]*(\([^()\n]*\))?(\?\.[A-Za-z_$][\w$]*)?", x[1].strip()) for x in exprs)
                ok_len = sum(len(x[1]) for x in exprs) < 150
                if no_expr and len(joined) <= MAX_JSX:
                    k = key_for(joined)
                    if k is not None:
                        ops.append((i, e, 't("%s")' % esc(k)))
                elif simple and ok_len:
                    out = ["tx("]
                    for p in parts:
                        if isinstance(p, str):
                            if AR.search(p):
                                k = key_for(p)
                                out.append('t("%s")' % esc(k if k else p))
                            else:
                                out.append('""' if p == "" else '"%s"' % p.replace('"', '\\"'))
                        else:
                            out.append("(" + p[1] + ")")
                        out.append(", ")
                    if out[-1] == ", ":
                        out.pop()
                    out.append(")")
                    ops.append((i, e, "".join(out)))
            i = e; continue
        if c == "<":
            m = re.match(r"<(/?)([A-Za-z_][\w.:-]*)?", src[i:])
            if not m:
                i += 1; continue
            closing = m.group(1) == "/"
            name = m.group(2) or ""
            j = i + m.end()
            attr_spans = []
            while j < n:
                if j in S.code:
                    ch = src[j]
                    if ch == "{":
                        j = S.find_matching(j) + 1; continue
                    if ch in "\"'":
                        e2 = skip_region(src, j)
                        s2 = j - 1
                        while s2 > i and (src[s2].isalnum() or src[s2] in "-_"):
                            s2 -= 1
                        attr_spans.append((s2 + 1, e2, src[s2+1:j]))
                        j = e2; continue
                    if ch == ">":
                        j += 1; break
                j += 1
            raw_end = j
            raw = src[i:raw_end]
            new_raw = raw
            for (a, b, nm) in sorted(attr_spans, key=lambda x: -x[0]):
                if nm.lower() not in ("placeholder", "alt", "title", "aria-label"): continue
                mm = re.match(r'[A-Za-z-]+="([^"]*)"', src[a:b])
                if not mm: continue
                v = mm.group(1)
                if not AR.search(v) or len(v) > MAX_JSX or not in_comp(i): continue
                k = key_for(v)
                if k is None: continue
                rep = '%s={t("%s")}' % (nm, esc(k))
                new_raw = new_raw[:a-i] + rep + new_raw[b-i:]
            if new_raw != raw:
                ops.append((i, raw_end, new_raw))
            # stack
            if closing:
                if tag_stack: tag_stack.pop()
            elif name == "":
                tag_stack.append(("frag", ""))
            elif raw.rstrip().endswith("/>"):
                pass
            else:
                is_comp = bool(name) and name[0].isupper()
                tag_stack.append((("comp" if is_comp else "html"), name))
                if is_comp:
                    # capture JSX text child right after this opening tag
                    k2 = raw_end
                    while k2 < n and src[k2] in " \t\r\n": k2 += 1
                    if k2 < n and src[k2] not in "<{":
                        # text till next '<' or '{' at code level
                        e3 = k2
                        while e3 < n and src[e3] not in "<{":
                            e3 += 1
                        txt = src[k2:e3].strip()
                        if (txt and AR.search(txt) and len(txt) <= MAX_JSX
                                and "{" not in txt and "<" not in txt and "&" not in txt
                                and "\\" not in txt):
                            st_abs = k2 + (len(src[k2:e3]) - len(src[k2:e3].lstrip()))
                            kk = key_for(txt)
                            if kk is not None:
                                ops.append((st_abs, st_abs + len(txt), '{t("%s")}' % esc(kk)))
            i = raw_end; continue
        if c == "{" and i in S.code:
            i = S.find_matching(i) + 1; continue
        i += 1

    # ---- JSX text between tags (generic) using code positions & surrounding '>'/'<' ----
    for m in re.finditer(r">\s*([^<>{}]+?)\s*<", src):
        inner = m.group(1)
        ls = inner.lstrip()
        off = len(inner) - len(ls)
        stripped = ls.rstrip()
        if not stripped or not AR.search(stripped): continue
        if len(stripped) > MAX_JSX: continue
        if any(ch in stripped for ch in "{}<>|&\\/"): continue
        start_abs = m.start(1) + off
        if not all((start_abs + x) in S.code for x in range(len(stripped))): continue
        gt = m.start(); lt = m.end() - 1
        if src[gt] != ">" or src[lt] != "<": continue
        if not in_comp(start_abs): continue
        kk = key_for(stripped)
        if kk is None: continue
        ops.append((start_abs, start_abs + len(stripped), '{t("%s")}' % esc(kk)))

    ops.sort(key=lambda o: o[0])
    out = []; cur = 0
    for st, en, rep in ops:
        if st < cur: continue
        out.append(src[cur:st]); out.append(rep); cur = en
    out.append(src[cur:])
    return "".join(out), sorted(set(entries))

HOOK = "const { t, tx, lang } = useI18n();"

def add_hooks(src, fname):
    rel = "./i18n/LanguageContext" if fname == "src/App.tsx" else "../i18n/LanguageContext"
    if "useI18n" not in src:
        lines = src.split("\n")
        ins = 0; depth = 0
        for idx, ln in enumerate(lines):
            st = ln.strip()
            if depth > 0:
                depth += st.count("{") - st.count("}")
                if depth == 0:
                    ins = idx + 1
                continue
            if st.startswith("import"):
                depth = st.count("{") - st.count("}")
                if depth == 0:
                    ins = idx + 1
                continue
            if st == "" or st.startswith("//") or st.startswith("/*") or st.startswith("*"):
                continue
            break
        lines.insert(ins, 'import { useI18n } from "%s";' % rel)
        src = "\n".join(lines)

    S = Src(src)
    fn_defs = []
    for m in FN_PAT.finditer(src):
        if not fn_name(m)[:1].isupper():
            continue
        k = m.end()
        n = len(src)
        while k < n and src[k] in " \t\r\n": k += 1
        if k >= n or src[k] != "{": continue
        close = S.find_matching(k)
        body = src[k:close+1]
        if re.search(r"(?<![\w$.])t\(", body) or re.search(r"(?<![\w$.])tx\(", body):
            if HOOK in body: continue
            fn_defs.append((k, close))
    fn_defs.sort()
    filtered = []; last_close = -1
    for k, close in fn_defs:
        if k < last_close: continue
        filtered.append((k, close)); last_close = close
    out = []; cur = 0
    for k, close in filtered:
        out.append(src[cur:k+1])
        nl = src.find("\n", k)
        indent = re.match(r"\s*", src[nl+1:]).group(0) if nl >= 0 else ""
        out.append("\n" + indent + "  " + HOOK)
        cur = k + 1
    out.append(src[cur:])
    return "".join(out)

def main():
    dry = "--dry" in sys.argv
    pairs = json.load(open(PAIRS, encoding="utf-8"))
    missing_new = {}
    total = 0
    for f in FILES:
        path = os.path.join(ROOT, f)
        new, used = process_file(path, pairs, missing_new)
        total += len(used)
        changed = new != open(path, encoding="utf-8").read()
        print("%-40s changed=%-5s translated=%d" % (f, changed, len(used)))
        if changed and not dry:
            new = add_hooks(new, f)
            open(path, "w", encoding="utf-8").write(new)
    json.dump({k: sorted(v) for k, v in missing_new.items()},
              open(os.path.join(ROOT, "tools/missing_en.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("TOTAL:", total, "NEEDS EN:", sum(len(v) for v in missing_new.values()), missing_new.keys())

if __name__ == "__main__":
    main()
