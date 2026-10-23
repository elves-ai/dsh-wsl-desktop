/** Small safe subset: no raw HTML, images, or automatic external links. */
export type MarkdownBlock = { type: 'paragraph' | 'code'; text: string } | { type: 'list'; ordered: boolean; items: string[] };
export type InlinePart = { type: 'text' | 'code' | 'strong'; text: string };
export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let marker = -1; let width = 0; let type: 'code' | 'strong' = 'code';
    for (let i = cursor; i < text.length; i++) {
      if (text.charCodeAt(i) === 96) { marker = i; width = 1; type = 'code'; break; }
      if (text[i] === '*' && text[i + 1] === '*') { marker = i; width = 2; type = 'strong'; break; }
    }
    if (marker < 0) { parts.push({ type: 'text', text: text.slice(cursor) }); break; }
    if (marker > cursor) parts.push({ type: 'text', text: text.slice(cursor, marker) });
    const delimiter = width === 1 ? String.fromCharCode(96) : '**';
    const end = text.indexOf(delimiter, marker + width);
    if (end <= marker + width || text.slice(marker + width, end).includes('\n')) {
      parts.push({ type: 'text', text: delimiter }); cursor = marker + width; continue;
    }
    parts.push({ type, text: text.slice(marker + width, end) }); cursor = end + width;
  }
  return parts;
}
export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  const listItem = (line: string) => /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(line);
  const isFence = (line: string) => line.trimStart().startsWith(String.fromCharCode(96).repeat(3));
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    if (isFence(lines[i])) {
      i++; const content: string[] = [];
      while (i < lines.length && !isFence(lines[i])) content.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: 'code', text: content.join('\n') }); continue;
    }
    const first = listItem(lines[i]);
    if (first) {
      const ordered = !!first[2]; const items: string[] = [];
      while (i < lines.length) {
        const match = listItem(lines[i]); if (!match || !!match[2] !== ordered) break;
        items.push(match[3]); i++;
      }
      blocks.push({ type: 'list', ordered, items }); continue;
    }
    const paragraph: string[] = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !isFence(lines[i]) && !listItem(lines[i])) paragraph.push(lines[i++]);
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}
export function renderMarkdown(target: HTMLElement, text: string, doc: Document): void {
  const inline = (parent: HTMLElement, value: string) => {
    for (const part of parseInline(value)) {
      const node = doc.createElement(part.type === 'code' ? 'code' : part.type === 'strong' ? 'strong' : 'span');
      node.textContent = part.text; parent.append(node);
    }
  };
  const fragment = doc.createDocumentFragment();
  for (const block of parseMarkdown(text)) {
    if (block.type === 'list') {
      const list = doc.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) { const li = doc.createElement('li'); inline(li, item); list.append(li); }
      fragment.append(list);
    } else if (block.type === 'code') {
      const pre = doc.createElement('pre'); const code = doc.createElement('code');
      code.textContent = block.text; pre.append(code); fragment.append(pre);
    } else {
      const paragraph = doc.createElement('p'); inline(paragraph, block.text); fragment.append(paragraph);
    }
  }
  target.replaceChildren(fragment);
}
