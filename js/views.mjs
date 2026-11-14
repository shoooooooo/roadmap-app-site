export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'required') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
export const button = (text, onclick, attrs = {}) => el('button', { type: 'button', onclick, ...attrs }, text);
export const p = (text, cls = '') => el('p', { class: cls }, text);
export function field(label, name, attrs = {}, value = '') {
  const input = el('input', { id: name, name, ...attrs }); input.value = value;
  return el('div', {}, el('label', { for: name }, label), input);
}
export function selectField(label, name, options, value) {
  const select = el('select', { id: name, name });
  for (const [v, text] of options) select.append(el('option', { value: v }, text));
  if (value !== undefined) select.value = value;
  return el('div', {}, el('label', { for: name }, label), select);
}
export const statusLabel = r => !r ? '未記録' : r.status === 'rest' ? '休み' : r.status === 'adopted' ? '採用中・未実施' : `実施 ${r.minutes}分${r.slot === 'morning' ? '・朝' : r.slot === 'after-work' ? '・仕事後' : ''}`;
