export interface JsonToken {
  text: string;
  kind: "key" | "string" | "number" | "literal" | "punctuation" | "space";
}

export function jsonTokens(source: string): JsonToken[] {
  const pattern =
    /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|\s+|./g;
  return [...source.matchAll(pattern)].map((match) => {
    const text = match[0];
    const kind = /^\s+$/.test(text)
      ? "space"
      : text.startsWith('"')
        ? source
            .slice(match.index! + text.length)
            .trimStart()
            .startsWith(":")
          ? "key"
          : "string"
        : /^-?\d/.test(text)
          ? "number"
          : /^(true|false|null)$/.test(text)
            ? "literal"
            : "punctuation";
    return { text, kind };
  });
}

/** Validate syntax, then format tokens without changing numbers, strings, or duplicate keys. */
export function formatJson(source: string) {
  JSON.parse(source);
  const tokens = jsonTokens(source).filter((token) => token.kind !== "space");
  const compact = tokens.map((token) => token.text).join("");
  let pretty = "",
    depth = 0;
  const newline = () => "\n" + "  ".repeat(depth);
  for (const [index, token] of tokens.entries()) {
    const text = token.text;
    if (text === "{" || text === "[") {
      pretty += text;
      depth++;
      if (!["}", "]"].includes(tokens[index + 1]?.text)) pretty += newline();
    } else if (text === "}" || text === "]") {
      depth--;
      if (!["{", "["].includes(tokens[index - 1]?.text)) pretty += newline();
      pretty += text;
    } else if (text === ",") pretty += text + newline();
    else if (text === ":") pretty += ": ";
    else pretty += text;
  }
  return { compact, pretty };
}

export function isJsonContainer(value: string) {
  if (!/^[\s]*[\[{]/.test(value)) return false;
  try {
    formatJson(value);
    return true;
  } catch {
    return false;
  }
}
