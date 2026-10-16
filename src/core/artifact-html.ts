import * as css from 'css-tree';
import {
  parse,
  serialize,
  defaultTreeAdapter,
  Tokenizer,
  TokenizerMode,
  type DefaultTreeAdapterTypes as Html,
} from 'parse5';

export const MAX_ARTIFACT_HTML_LENGTH = 100_000;
const MAX_HTML_NODES = 10_000;
const MAX_HTML_DEPTH = 32;
const MAX_HTML_BYTES = 256 * 1024;
const forbiddenTags = new Set(
  'script math canvas iframe object embed img image video audio link base animate set input textarea select option optgroup template noscript use textpath'.split(
    ' ',
  ),
);
const resourceAttributes = new Set(
  'clip-path color-profile cursor fill filter marker marker-end marker-mid marker-start mask mask-image shape-inside shape-outside stroke'.split(
    ' ',
  ),
);
const boundaries = new Set(
  'address article aside blockquote br caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul'.split(
    ' ',
  ),
);
const functions = new Set(
  'abs acos asin atan atan2 blur brightness calc circle clamp color color-mix conic-gradient contrast cos counter counters drop-shadow ellipse env exp format grayscale has hsl hsla hue-rotate hwb hypot inset invert is lab lch light-dark linear-gradient local log matrix matrix3d max min mod not nth-child nth-last-child nth-last-of-type nth-of-type oklab oklch opacity path perspective polygon pow radial-gradient rect rem repeating-conic-gradient repeating-linear-gradient repeating-radial-gradient rgb rgba rotate rotate3d rotatex rotatey rotatez round saturate scale scale3d scalex scaley scalez sepia sign sin skew skewx skewy sqrt tan tech translate translate3d translatex translatey translatez var where xywh'.split(
    ' ',
  ),
);
const markers =
  'none disc circle square decimal decimal-leading-zero lower-roman upper-roman lower-alpha upper-alpha lower-latin upper-latin lower-greek'.split(
    ' ',
  );
const generatedKeywords: Record<string, Set<string>> = {
  display: new Set(
    'block inline inline-block flex inline-flex grid inline-grid table inline-table table-row-group table-header-group table-footer-group table-row table-cell table-caption flow flow-root contents list-item'.split(
      ' ',
    ),
  ),
  visibility: new Set(['visible']),
  'content-visibility': new Set(['visible']),
  quotes: new Set(['auto', 'none', 'inherit', 'initial', 'revert', 'revert-layer', 'unset']),
  'list-style': new Set([...markers, 'inside', 'outside']),
  'list-style-type': new Set(markers),
  'text-overflow': new Set(['clip', 'ellipsis']),
  'block-ellipsis': new Set(['none', 'auto', 'no-ellipsis']),
  'hyphenate-character': new Set(['auto']),
  '-webkit-hyphenate-character': new Set(['auto']),
  'counter-increment': new Set(['none']),
  'counter-reset': new Set(['none']),
  'counter-set': new Set(['none']),
};

const lower = (name: string): string => css.ident.decode(name).toLowerCase();
const unsupported = (): never => {
  throw new Error('Unsupported artifact HTML');
};

/** Bound source nesting before HTML recovery can build a quadratic-depth tree. */
function preflightHtml(source: string): void {
  const stack: string[] = [];
  const voidTags = new Set(
    'area base br col embed hr img input link meta param source track wbr'.split(' '),
  );
  const integration = new Set(['foreignobject', 'desc', 'title']);
  const breakout = new Set(
    'b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var font'.split(
      ' ',
    ),
  );
  const inSvg = (): boolean => {
    const index = stack.lastIndexOf('svg');
    return index >= 0 && !stack.slice(index + 1).some((tag) => integration.has(tag));
  };
  let count = 0;
  const token = (): void => {
    if (++count > MAX_HTML_NODES) unsupported();
  };
  const tokenizer = new Tokenizer(
    {},
    {
      onComment: token,
      onDoctype(doctype) {
        token();
        if (
          doctype.name !== 'html' ||
          doctype.publicId !== null ||
          doctype.systemId !== null ||
          doctype.forceQuirks
        )
          unsupported();
      },
      onEof: () => {},
      onCharacter: token,
      onNullCharacter: token,
      onWhitespaceCharacter: token,
      onStartTag(tag) {
        token();
        if (forbiddenTags.has(tag.tagName)) unsupported();
        const foreign = inSvg();
        if (foreign && breakout.has(tag.tagName)) unsupported();
        // HTML ignores '/>' on nonvoid elements; only verified SVG context permits it.
        if (tag.selfClosing && !voidTags.has(tag.tagName) && tag.tagName !== 'svg' && !foreign)
          unsupported();
        if (!voidTags.has(tag.tagName) && !tag.selfClosing) {
          stack.push(tag.tagName);
          if (stack.length > MAX_HTML_DEPTH) unsupported();
        }
        if (tag.selfClosing) return;
        if (['style', 'xmp', 'iframe', 'noembed', 'noframes'].includes(tag.tagName))
          tokenizer.state = TokenizerMode.RAWTEXT;
        else if (!foreign && ['title', 'textarea'].includes(tag.tagName))
          tokenizer.state = TokenizerMode.RCDATA;
        else if (tag.tagName === 'plaintext') tokenizer.state = TokenizerMode.PLAINTEXT;
      },
      onEndTag(tag) {
        token();
        const index = stack.lastIndexOf(tag.tagName);
        if (index >= 0) {
          if (index !== stack.length - 1) unsupported();
          stack.pop();
        }
      },
    },
  );
  tokenizer.write(source, true);
}

function parseBounded(source: string): Html.Document {
  preflightHtml(source);
  let nodes = 0;
  const checkParent = (parent: Html.ParentNode): void => {
    let node: Html.Node | null = parent;
    let depth = 0;
    while (node) {
      if (++depth > MAX_HTML_DEPTH) unsupported();
      node = 'parentNode' in node ? node.parentNode : null;
    }
  };
  return parse(source, {
    scriptingEnabled: false,
    treeAdapter: {
      ...defaultTreeAdapter,
      createElement(...args) {
        if (++nodes > MAX_HTML_NODES) unsupported();
        return defaultTreeAdapter.createElement(...args);
      },
      appendChild(parent, child) {
        checkParent(parent);
        defaultTreeAdapter.appendChild(parent, child);
      },
      insertBefore(parent, child, reference) {
        checkParent(parent);
        defaultTreeAdapter.insertBefore(parent, child, reference);
      },
    },
  });
}

function validateCss(source: string, context: 'stylesheet' | 'declarationList' | 'value'): void {
  if (source.includes('\\')) unsupported();
  const ast = css.parse(source, { context, parseCustomProperty: true });
  css.walk(ast, (node) => {
    if (node.type === 'Raw') unsupported();
    if (node.type === 'Atrule' && ['import', 'counter-style'].includes(lower(node.name)))
      unsupported();
    if (node.type === 'Url' && !node.value.startsWith('#')) unsupported();
    if (node.type === 'Function' && !functions.has(lower(node.name))) unsupported();
    if (node.type === 'Function' && lower(node.name) === 'opacity') {
      const values = node.children.toArray();
      const value = values[0];
      if (
        values.length !== 1 ||
        !value ||
        !(
          (value.type === 'Number' && Number(value.value) === 1) ||
          (value.type === 'Percentage' && Number(value.value) === 100)
        )
      )
        unsupported();
    }
    if (node.type !== 'Declaration') return;
    if (node.value.type !== 'Value') return unsupported();
    const name = lower(node.property);
    const values = node.value.children.toArray();
    if (['opacity', 'fill-opacity', 'stroke-opacity'].includes(name)) {
      const value = values[0];
      if (
        values.length !== 1 ||
        !value ||
        !(
          (value.type === 'Number' && Number(value.value) === 1) ||
          (value.type === 'Percentage' && Number(value.value) === 100)
        )
      )
        unsupported();
    }
    if (name === 'content') {
      const first = values[0];
      if (
        values.length !== 1 ||
        !first ||
        !(
          (first.type === 'Identifier' && ['none', 'normal'].includes(lower(first.name))) ||
          (first.type === 'String' && first.value === '')
        )
      )
        unsupported();
    }
    const allowed = generatedKeywords[name];
    if (name === 'quotes' && values.length !== 1) unsupported();
    if (
      allowed &&
      (!values.length || values.some((v) => v.type !== 'Identifier' || !allowed.has(lower(v.name))))
    )
      unsupported();
    if (
      ['line-clamp', '-webkit-line-clamp'].includes(name) &&
      (!values.length ||
        values.some(
          (v) =>
            !(
              (v.type === 'Identifier' &&
                ['none', 'auto', 'no-ellipsis'].includes(lower(v.name))) ||
              (v.type === 'Number' && Number.isInteger(Number(v.value)) && Number(v.value) > 0)
            ),
        ))
    )
      unsupported();
  });
}

function children(node: Html.Node): Html.ChildNode[] {
  const result = 'childNodes' in node ? node.childNodes : [];
  return 'tagName' in node && node.tagName === 'template'
    ? [...result, ...(node as Html.Template).content.childNodes]
    : result;
}

function visit(root: Html.Node, fn: (node: Html.Node) => void): void {
  const stack = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) break;
    if (++count > MAX_HTML_NODES || entry.depth > MAX_HTML_DEPTH) unsupported();
    fn(entry.node);
    for (const node of children(entry.node)) stack.push({ node, depth: entry.depth + 1 });
  }
}

function validateDocument(root: Html.Document): void {
  visit(root, (node) => {
    if (!('tagName' in node)) return;
    const tag = node.tagName.toLowerCase();
    if (forbiddenTags.has(tag)) unsupported();
    if (['defs', 'symbol', 'clippath', 'mask', 'metadata'].includes(tag)) {
      visit(node, (child) => {
        if (child.nodeName === '#text' && (child as Html.TextNode).value.trim()) unsupported();
      });
    }
    const has = (name: string): boolean => node.attrs.some((a) => a.name.toLowerCase() === name);
    if (
      (tag === 'ol' && has('start')) ||
      (tag === 'li' && has('value')) ||
      (tag === 'meta' && has('http-equiv')) ||
      has('hidden') ||
      has('popover') ||
      (['dialog', 'details'].includes(tag) && !has('open'))
    )
      unsupported();
    node.attrs = node.attrs.filter((attr) => {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith('on') ||
        ['src', 'srcset', 'action', 'formaction', 'background'].includes(name)
      )
        unsupported();
      if (name === 'href') {
        if (tag === 'a') return false;
        if (!attr.value.startsWith('#')) unsupported();
      }
      if (resourceAttributes.has(name)) validateCss(attr.value, 'value');
      if (
        [
          'display',
          'visibility',
          'content-visibility',
          'opacity',
          'fill-opacity',
          'stroke-opacity',
        ].includes(name)
      )
        validateCss(`${name}:${attr.value}`, 'declarationList');
      if (name === 'style') validateCss(attr.value, 'declarationList');
      return true;
    });
    if (tag === 'style')
      validateCss(
        children(node)
          .map((child) => ('value' in child ? child.value : ''))
          .join(''),
        'stylesheet',
      );
  });
}

function retainedText(node: Html.Node, separate: boolean, visible = false): string {
  if (node.nodeName === '#text') return (node as Html.TextNode).value;
  if ('tagName' in node && ['style', 'script'].includes(node.tagName)) return '';
  if (
    visible &&
    'tagName' in node &&
    ['head', 'title', 'desc', 'defs', 'symbol', 'clippath', 'mask', 'metadata'].includes(
      node.tagName.toLowerCase(),
    )
  )
    return '';
  const boundary = separate && 'tagName' in node && boundaries.has(node.tagName) ? '\n' : '';
  return (
    boundary +
    children(node)
      .map((child) => retainedText(child, separate, visible))
      .join('') +
    boundary
  );
}

export function validateHtml(source: string): string {
  if (
    source.length > MAX_ARTIFACT_HTML_LENGTH ||
    new TextEncoder().encode(source).length > MAX_HTML_BYTES
  )
    unsupported();
  const document = parseBounded(source);
  validateDocument(document);
  const result = serialize(document);
  if (
    result.length > MAX_ARTIFACT_HTML_LENGTH ||
    new TextEncoder().encode(result).length > MAX_HTML_BYTES
  )
    unsupported();
  return result;
}

/** Bounded static HTML policy, not a browser-layout redactor or general artifact schema validator. */
export function prepareHtml(source: string, redact: (value: string) => string): string {
  if (
    source.length > MAX_ARTIFACT_HTML_LENGTH ||
    new TextEncoder().encode(source).length > MAX_HTML_BYTES
  )
    unsupported();
  const document = parseBounded(source);
  validateDocument(document);
  visit(document, (node) => {
    if ('tagName' in node && redact(node.tagName) !== node.tagName) unsupported();
    if ('attrs' in node)
      for (const attr of node.attrs) {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        if (redact(name) !== name) unsupported();
      }
    if ('childNodes' in node)
      node.childNodes = node.childNodes.filter((child) => child.nodeName !== '#comment');
    if ('tagName' in node && node.tagName === 'template') {
      const template = node as Html.Template;
      template.content.childNodes = template.content.childNodes.filter(
        (child) => child.nodeName !== '#comment',
      );
    }
    if (node.nodeName === '#text') {
      const text = node as Html.TextNode;
      text.value = redact(text.value);
    }
    if ('attrs' in node) for (const attr of node.attrs) attr.value = redact(attr.value);
  });
  validateDocument(document);
  const result = serialize(document);
  if (
    result.length > MAX_ARTIFACT_HTML_LENGTH ||
    new TextEncoder().encode(result).length > MAX_HTML_BYTES
  )
    unsupported();
  if (redact(result) !== result) unsupported();
  const normalized = parseBounded(result);
  validateDocument(normalized);
  const views = new Set<string>();
  for (const visible of [false, true]) {
    const joined = retainedText(normalized, false, visible);
    const separated = retainedText(normalized, true, visible);
    views.add(joined);
    views.add(separated);
    for (const view of [joined, separated, ...separated.split('\n')])
      views.add(view.replace(/\s+/gu, ' ').trim());
  }
  for (const view of views) if (view && redact(view) !== view) unsupported();
  return result;
}
