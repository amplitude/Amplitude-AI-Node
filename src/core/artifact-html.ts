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
  'script math canvas iframe object embed img image video audio link base animate set input textarea select option optgroup template noscript use textpath basefont datalist noembed noframes rp'.split(
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
const defaultIgnorables = /[\p{Default_Ignorable_Code_Point}\u00ad]/gu;
const privacyText = (value: string): string => value.replace(defaultIgnorables, '');
function checkPrivacyText(value: string, redact: (text: string) => string): void {
  const normalized = privacyText(value);
  if (normalized !== value && redact(normalized) !== normalized) unsupported();
}
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

// Explicit text-style subset shared with the Python SDK; geometry never relaxes resource checks.
const absoluteFontUnits: Record<string, number> = {
  px: 1.0,
  pt: 1.3333333333333333,
  pc: 16.0,
  in: 96.0,
  cm: 37.79527559055118,
  mm: 3.7795275590551185,
  q: 0.9448818897637796,
};
const textKeywords: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    position: ['static'],
    overflow: ['visible'],
    'overflow-x': ['visible'],
    'overflow-y': ['visible'],
    transform: ['none'],
    clip: ['auto'],
    'clip-path': ['none'],
    mask: ['none'],
    'mask-image': ['none'],
    'font-style': ['italic', 'normal', 'oblique'],
    'font-variant': ['normal', 'small-caps'],
    'font-weight': ['bold', 'bolder', 'lighter', 'normal'],
    'text-align': ['center', 'end', 'justify', 'left', 'right', 'start'],
    'text-decoration': [
      'dashed',
      'dotted',
      'double',
      'line-through',
      'none',
      'overline',
      'solid',
      'underline',
      'wavy',
    ],
    'text-decoration-line': ['line-through', 'none', 'overline', 'underline'],
    'text-transform': ['none'],
    'white-space': ['break-spaces', 'normal', 'nowrap', 'pre', 'pre-line', 'pre-wrap'],
    'word-break': ['break-all', 'break-word', 'keep-all', 'normal'],
    'overflow-wrap': ['anywhere', 'break-word', 'normal'],
    'border-collapse': ['collapse', 'separate'],
    'table-layout': ['auto', 'fixed'],
    'box-sizing': ['border-box', 'content-box'],
    'text-anchor': ['end', 'middle', 'start'],
    'dominant-baseline': [
      'alphabetic',
      'auto',
      'central',
      'hanging',
      'middle',
      'text-after-edge',
      'text-before-edge',
    ],
  }).map(([key, values]) => [key, new Set(values)]),
);
const lengthUnits = new Set([
  'ch',
  'cm',
  'em',
  'ex',
  'in',
  'lh',
  'mm',
  'pc',
  'pt',
  'px',
  'q',
  'rem',
  'rlh',
  'vh',
  'vmax',
  'vmin',
  'vw',
]);
const colorProperties = new Set(['color', 'fill', 'stroke', 'text-decoration-color']);
const backgroundProperties = new Set([
  'background',
  'background-color',
  'border-bottom-color',
  'border-color',
  'border-left-color',
  'border-right-color',
  'border-top-color',
]);
const spacingProperties = new Set([
  'border-radius',
  'border-spacing',
  'column-gap',
  'gap',
  'letter-spacing',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'row-gap',
  'word-spacing',
]);
const sizeProperties = new Set([
  'grid-template-columns',
  'grid-template-rows',
  'height',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'width',
]);
const borderProperties = new Set([
  'border',
  'border-bottom',
  'border-bottom-width',
  'border-left',
  'border-left-width',
  'border-right',
  'border-right-width',
  'border-style',
  'border-top',
  'border-top-width',
  'border-width',
]);
const borderKeywords = new Set([
  'dashed',
  'dotted',
  'double',
  'groove',
  'hidden',
  'inset',
  'medium',
  'none',
  'outset',
  'ridge',
  'solid',
  'thick',
  'thin',
]);
const namedColors = new Set([
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
]);

function literalLength(value: css.CssNode, positive: boolean, fractional = false): boolean {
  if (!['Number', 'Percentage', 'Dimension'].includes(value.type)) return false;
  if (value.type !== 'Number' && value.type !== 'Percentage' && value.type !== 'Dimension')
    return false;
  const number = Number(value.value);
  return (
    Number.isFinite(number) &&
    (positive ? number > 0 : number >= 0) &&
    (value.type !== 'Dimension' ||
      lengthUnits.has(lower(value.unit)) ||
      (fractional && lower(value.unit) === 'fr'))
  );
}
function absoluteTextSize(value: css.CssNode): boolean {
  return (
    (value.type === 'Number' && Number.isFinite(Number(value.value)) && Number(value.value) >= 1) ||
    (value.type === 'Dimension' &&
      Number.isFinite(Number(value.value)) &&
      Number(value.value) * (absoluteFontUnits[lower(value.unit)] ?? 0) >= 1)
  );
}
function supportedColor(value: css.CssNode, opaque: boolean): boolean {
  if (value.type === 'Identifier') {
    const name = lower(value.name);
    return name === 'currentcolor' || namedColors.has(name) || (!opaque && name === 'transparent');
  }
  if (value.type === 'Hash') {
    const hex = value.value;
    if (!/^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(hex)) return false;
    return (
      !opaque ||
      (hex.length !== 4 && hex.length !== 8) ||
      (hex.length === 4
        ? hex.endsWith('f') || hex.endsWith('F')
        : hex.slice(-2).toLowerCase() === 'ff')
    );
  }
  if (value.type !== 'Function') return false;
  const name = lower(value.name);
  if (!['rgb', 'rgba', 'hsl', 'hsla'].includes(name)) return false;
  const components = value.children.toArray();
  const alpha = name.endsWith('a');
  if (components.length !== (alpha ? 7 : 5)) return false;
  for (let i = 1; i < components.length; i += 2) {
    const comma = components[i];
    if (comma?.type !== 'Operator' || comma.value !== ',') return false;
  }
  const values = components.filter((_, index) => index % 2 === 0);
  if (
    values.some(
      (part) =>
        (part.type !== 'Number' && part.type !== 'Percentage') ||
        !Number.isFinite(Number(part.value)),
    )
  )
    return false;
  if (name.startsWith('rgb')) {
    if (!values.slice(0, 3).every((part) => part.type === values[0]?.type)) return false;
  } else if (
    values[0]?.type !== 'Number' ||
    values[1]?.type !== 'Percentage' ||
    values[2]?.type !== 'Percentage'
  )
    return false;
  const opacity = values[3];
  return !alpha || (opacity?.type === 'Number' && (!opaque || Number(opacity.value) >= 1));
}
function validateTextDeclaration(name: string, values: css.CssNode[]): void {
  if (
    generatedKeywords[name] ||
    ['content', 'opacity', 'fill-opacity', 'stroke-opacity'].includes(name)
  )
    return;
  const first = values[0];
  let valid = false;
  if (textKeywords[name]) {
    valid =
      values.length > 0 &&
      values.every((v) => v.type === 'Identifier' && textKeywords[name]?.has(lower(v.name)));
    if (name === 'font-weight' && values.length === 1 && first?.type === 'Number')
      valid = Number(first.value) > 0;
  } else if (colorProperties.has(name) || backgroundProperties.has(name)) {
    valid =
      values.length === 1 &&
      first !== undefined &&
      supportedColor(first, colorProperties.has(name));
  } else if (name === 'font-family') {
    valid =
      values.length > 0 &&
      values.every(
        (v) =>
          v.type === 'Identifier' ||
          v.type === 'String' ||
          (v.type === 'Operator' && v.value === ','),
      );
  } else if (name === 'font-size') {
    valid =
      values.length === 1 &&
      first !== undefined &&
      (absoluteTextSize(first) ||
        (first.type === 'Identifier' &&
          [
            'xx-small',
            'x-small',
            'small',
            'medium',
            'large',
            'x-large',
            'xx-large',
            'xxx-large',
          ].includes(lower(first.name))));
  } else if (name === 'line-height') {
    valid =
      values.length === 1 &&
      first !== undefined &&
      (literalLength(first, true) ||
        (first.type === 'Identifier' && lower(first.name) === 'normal'));
  } else if (sizeProperties.has(name) && !name.startsWith('grid-')) {
    valid =
      values.length === 1 &&
      first !== undefined &&
      (absoluteTextSize(first) ||
        (first.type === 'Identifier' &&
          (lower(first.name) === 'auto' ||
            (name.startsWith('max-') && lower(first.name) === 'none'))));
  } else if (spacingProperties.has(name) || sizeProperties.has(name)) {
    valid =
      values.length > 0 &&
      values.every(
        (v) =>
          literalLength(v, sizeProperties.has(name), name.startsWith('grid-')) ||
          (v.type === 'Identifier' && ['auto', 'normal'].includes(lower(v.name))),
      );
  } else if (borderProperties.has(name)) {
    valid =
      values.length > 0 &&
      values.every(
        (v) =>
          literalLength(v, false) ||
          (v.type === 'Identifier' && borderKeywords.has(lower(v.name))) ||
          supportedColor(v, false),
      );
  } else if (name === 'filter') {
    valid =
      values.length === 1 &&
      ((first?.type === 'Identifier' && lower(first.name) === 'none') ||
        (first?.type === 'Function' && lower(first.name) === 'opacity'));
  }
  if (!valid) unsupported();
}

function validateCss(
  source: string,
  context: 'stylesheet' | 'declarationList' | 'value',
  geometry = false,
): void {
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
    if (!geometry) validateTextDeclaration(name, values);
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

const presentationAttributes = new Set(
  'alignment-baseline baseline-shift clip clip-path clip-rule color color-interpolation color-interpolation-filters color-profile color-rendering cursor direction display dominant-baseline enable-background fill fill-opacity fill-rule filter flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-orientation-horizontal glyph-orientation-vertical image-rendering kerning letter-spacing lighting-color marker marker-end marker-mid marker-start mask opacity overflow paint-order pointer-events shape-rendering stop-color stop-opacity stroke stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering unicode-bidi vector-effect visibility white-space word-spacing writing-mode content-visibility mask-image shape-inside shape-outside'.split(
    ' ',
  ),
);
function textTransform(source: string): boolean {
  const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  const pattern = new RegExp(
    `(translate|rotate)\\(\\s*(${number}(?:[ ,]+${number}){0,2})\\s*\\)`,
    'gu',
  );
  let end = 0;
  let count = 0;
  for (const match of source.matchAll(pattern)) {
    if (source.slice(end, match.index).trim()) return false;
    const values = match[2]?.split(/[ ,]+/u).map(Number) ?? [];
    if (
      !values.every(Number.isFinite) ||
      (match[1] === 'translate' ? ![1, 2].includes(values.length) : ![1, 3].includes(values.length))
    )
      return false;
    end = (match.index ?? 0) + match[0].length;
    count++;
  }
  return count > 0 && !source.slice(end).trim();
}

function validateDocument(root: Html.Document): void {
  visit(root, (node) => {
    if (!('tagName' in node)) return;
    const tag = node.tagName.toLowerCase();
    const svg = node.namespaceURI === 'http://www.w3.org/2000/svg';
    let textBearing = retainedText(node, false, true).trim().length > 0;
    if (svg)
      visit(node, (descendant) => {
        if (
          'tagName' in descendant &&
          ['text', 'tspan', 'foreignobject'].includes(descendant.tagName.toLowerCase())
        )
          textBearing = true;
      });
    const geometry = svg && !textBearing;
    if (forbiddenTags.has(tag)) unsupported();
    if (['defs', 'symbol', 'clippath', 'mask', 'metadata'].includes(tag)) {
      visit(node, (child) => {
        if (child.nodeName === '#text' && (child as Html.TextNode).value.trim()) unsupported();
      });
    }
    const has = (name: string): boolean => node.attrs.some((a) => a.name.toLowerCase() === name);
    if (svg && textBearing && tag === 'foreignobject' && (!has('width') || !has('height')))
      unsupported();
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
      if (svg && textBearing) {
        if (['svg', 'foreignobject'].includes(tag) && ['width', 'height'].includes(name)) {
          const value = css.parse(attr.value, { context: 'value' });
          if (value.type !== 'Value') return unsupported();
          const values = value.children.toArray();
          const first = values[0];
          if (values.length !== 1 || !first || !absoluteTextSize(first)) unsupported();
        }

        if (tag === 'tspan' && ['x', 'y', 'dx', 'dy', 'rotate', 'transform'].includes(name))
          unsupported();
        if (['textlength', 'lengthadjust'].includes(name)) unsupported();
        if (name === 'transform' && !textTransform(attr.value)) unsupported();
      }
      if (
        name.startsWith('on') ||
        ['src', 'srcset', 'action', 'formaction', 'background'].includes(name)
      )
        unsupported();
      if (name === 'href') {
        if (tag === 'a') return false;
        if (!attr.value.startsWith('#')) unsupported();
      }
      if (resourceAttributes.has(name)) validateCss(attr.value, 'value', geometry);
      if (presentationAttributes.has(name))
        validateCss(`${name}:${attr.value}`, 'declarationList', geometry);
      if (name === 'style') validateCss(attr.value, 'declarationList', geometry);
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
    if ('tagName' in node) {
      checkPrivacyText(node.tagName, redact);
      if (redact(node.tagName) !== node.tagName) unsupported();
    }
    if ('attrs' in node)
      for (const attr of node.attrs) {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        checkPrivacyText(name, redact);
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
      checkPrivacyText(text.value, redact);
      text.value = redact(text.value);
    }
    if ('attrs' in node)
      for (const attr of node.attrs) {
        checkPrivacyText(attr.value, redact);
        attr.value = redact(attr.value);
      }
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
  for (const view of views)
    if (view) {
      checkPrivacyText(view, redact);
      if (redact(view) !== view) unsupported();
    }
  return result;
}
