/**
 * converter.js
 * Core logic: inject fp=unsafe&fm=<fragment> into VLESS/Trojan links,
 * preserving param order, dropping pbk. Shared by CLI + HTTP server.
 */

const DEFAULT_FRAGMENT = {
  tcp: [
    {
      type: 'fragment',
      settings: {
        packets: 'tlshello',
        lengths: ['5', '94', '1'],
        delays: ['0'],
        maxSplit: '0'
      }
    },
    {
      type: 'fragment',
      settings: {
        packets: '1-1',
        lengths: ['109', '1'],
        delays: ['1'],
        maxSplit: '355'
      }
    }
  ]
};

function injectFragment(link, fragmentObj = DEFAULT_FRAGMENT) {
  const fmValue = encodeURIComponent(JSON.stringify(fragmentObj));

  const hashIdx = link.indexOf('#');
  const label = hashIdx !== -1 ? link.slice(hashIdx) : '';
  const body = hashIdx !== -1 ? link.slice(0, hashIdx) : link;

  const qIdx = body.indexOf('?');
  if (qIdx === -1) return link;

  const prefix = body.slice(0, qIdx);
  const queryStr = body.slice(qIdx + 1);

  const pairs = queryStr
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf('=');
      return eq === -1 ? [p, ''] : [p.slice(0, eq), p.slice(eq + 1)];
    });

  const out = [];
  let fpHandled = false;
  for (const [k, v] of pairs) {
    if (k === 'pbk') continue;
    if (k === 'fp') {
      out.push(['fp', 'unsafe']);
      out.push(['fm', fmValue]);
      fpHandled = true;
      continue;
    }
    out.push([k, v]);
  }
  if (!fpHandled) {
    const typeIdx = out.findIndex(([k]) => k === 'type');
    const insertion = [
      ['fp', 'unsafe'],
      ['fm', fmValue]
    ];
    if (typeIdx === -1) out.push(...insertion);
    else out.splice(typeIdx, 0, ...insertion);
  }

  const newQuery = out.map(([k, v]) => `${k}=${v}`).join('&');
  return `${prefix}?${newQuery}${label}`;
}

function convertMany(links, fragmentObj) {
  return links
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => injectFragment(l, fragmentObj));
}

function looksLikeConfigLine(line) {
  return /^(vless|trojan|vmess|ss):\/\//i.test(line.trim());
}

// Subscription links commonly return either:
//   - plain text, one config per line
//   - the whole body base64-encoded (decodes to the same plain text)
function decodeSubscriptionContent(raw) {
  const trimmed = raw.trim();
  if (looksLikeConfigLine(trimmed.split('\n')[0] || '')) {
    return trimmed; // already plain
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (looksLikeConfigLine(decoded.split('\n')[0] || '')) {
      return decoded;
    }
  } catch {
    // fall through
  }
  return trimmed; // best effort, return as-is
}

module.exports = { injectFragment, convertMany, DEFAULT_FRAGMENT, decodeSubscriptionContent, looksLikeConfigLine };
