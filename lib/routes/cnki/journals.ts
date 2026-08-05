import { load } from 'cheerio';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import parser from '@/utils/rss-parser';

import { ProcessItem } from './utils';

// navi/rss.cnki.net only answer to mainland China IPs; oversea.cnki.net serves
// the same journal through POST endpoints with a different markup.
const DOMESTIC_ROOT = 'https://navi.cnki.net';
const OVERSEA_ROOT = 'https://oversea.cnki.net';
const OVERSEA_QS = 'language=CHS&uniplatform=OVERSEA';
const PCODE = encodeURIComponent('CJFD,CCJD');

const OVERSEA_HEADERS = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${OVERSEA_ROOT}/`,
    language: 'CHS',
    uniplatform: 'OVERSEA',
};

export const route: Route = {
    path: '/journals/:name',
    categories: ['journal'],
    example: '/cnki/journals/LKGP',
    parameters: {
        name: '期刊缩写，可以在网址中得到',
    },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['navi.cnki.net/knavi/journals/:name/detail'],
        },
        {
            source: ['oversea.cnki.net/knavi/journals/:name/detail'],
        },
    ],
    name: '期刊',
    maintainers: ['Fatpandac', 'Derekmini', 'pseudoyu', 'fredericky123'],
    description: `默认自动选择站点：先尝试境内 \`navi.cnki.net\`，失败则回退到境外 \`oversea.cnki.net\`，境内外服务器均可用。

| 用途 | 订阅地址 |
| --- | --- |
| 自动 | \`/cnki/journals/GLSJ\` |
| 强制境外（境外服务器建议，跳过探测更快） | \`/cnki/journals/GLSJ?host=oversea\` |
| 强制境内 | \`/cnki/journals/GLSJ?host=domestic\` |`,
    handler,
};

// ---------- oversea ----------

async function overseaPost(url: string, body: string) {
    try {
        const res = await got.post(url, { headers: OVERSEA_HEADERS, body });
        return res.data;
    } catch (error) {
        logger.error(`cnki: POST ${url} failed - ${(error as Error).message}`);
        const res = await got.get(url, { headers: OVERSEA_HEADERS });
        return res.data;
    }
}

// The oversea site encrypts its yearIssue token per session, but every issue
// of a journal shares a long common prefix, and the tokens are all embedded in
// the detail page. Group the page's long strings by prefix: the biggest group
// is the issue-token family (base64 font blobs never share a 40-char prefix).
function issueTokenCandidates(html: string) {
    const all = [...new Set(html.match(/[A-Za-z0-9_-]{100,200}/g) || [])];

    const groups = new Map<string, string[]>();
    for (const token of all) {
        const key = token.slice(0, 40);
        groups.set(key, [...(groups.get(key) || []), token]);
    }

    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
    // Fall back to every long string if no family stands out.
    return (best.length > 1 ? best : all).slice(0, 6);
}

function parsePapers(html: string, limit: number) {
    const $ = load(html);

    return $('dd')
        .toArray()
        .map((el) => {
            const $el = $(el);
            const $a = $el.find('span.name > a').first();
            const itemTitle = $a.text().trim();
            const link = $a.attr('href');
            if (!itemTitle || !link) {
                return null;
            }

            // e.g. GLSJ202607001 -> issue 2026-07
            const fileId = $el.find('b[name="encrypt"]').attr('id') || '';
            const ym = fileId.match(/[A-Z]+(\d{4})(\d{2})/i);

            const author = ($el.find('span.author').attr('title') || $el.find('span.author').text()).replace(/;$/, '').replaceAll(';', ', ').trim();
            const pages = ($el.find('span.company').attr('title') || $el.find('span.company').text()).trim();
            const section = $el.closest('div').find('dt.tit').first().text().trim();

            return {
                title: itemTitle,
                link,
                guid: fileId || link,
                author: author || undefined,
                description: [section ? `栏目：${section}` : '', author ? `作者：${author}` : '', pages ? `页码：${pages}` : ''].filter(Boolean).join('<br>') || itemTitle,
                pubDate: ym ? parseDate(`${ym[1]}${ym[2]}`, 'YYYYMM') : undefined,
            };
        })
        .filter(Boolean)
        .slice(0, limit);
}

async function fetchOversea(name: string, limit: number) {
    const journalUrl = `${OVERSEA_ROOT}/knavi/journals/${name}/detail?language=CHS`;
    const detailHtml = (await got.get(journalUrl, { headers: OVERSEA_HEADERS })).data;
    const title = load(detailHtml)('head > title').text().trim();

    // Try the candidate tokens in document order; the newest issue comes first.
    for (const token of issueTokenCandidates(detailHtml)) {
        const papersUrl = `${OVERSEA_ROOT}/knavi/journals/${name}/papers?yearIssue=${token}&pageIdx=0&pcode=${PCODE}&isEpublish=0&${OVERSEA_QS}`;
        try {
            const items = parsePapers(await overseaPost(papersUrl, ''), limit);
            if (items.length > 0) {
                return {
                    title: title || `CNKI - ${name}`,
                    link: journalUrl,
                    item: items,
                };
            }
        } catch (error) {
            logger.error(`cnki: oversea token attempt failed - ${(error as Error).message}`);
        }
    }

    throw new Error('cnki: no papers parsed from oversea');
}

// ---------- domestic ----------

async function fetchDomestic(name: string, limit: number) {
    const journalUrl = `${DOMESTIC_ROOT}/knavi/journals/${name}/detail`;
    const titleRes = await got.get(journalUrl);
    const title = load(titleRes.data)('head > title').text();

    const yearListRes = await got.get(`${DOMESTIC_ROOT}/knavi/journals/${name}/yearList?pIdx=0`);
    const $yearList = load(yearListRes.data);
    const first = $yearList('.yearissuepage').find('dl').first().find('dd').find('a').first();
    const code = first.attr('value');
    const issueId = first.attr('id');
    if (!code || !issueId) {
        throw new Error('cnki: cannot read issue list from domestic');
    }
    const date = parseDate(issueId.replace('yq', ''), 'YYYYMM');

    const response = await got.post(`${DOMESTIC_ROOT}/knavi/journals/${name}/papers?yearIssue=${code}&pageIdx=0&pcode=CJFD,CCJD`);
    const $ = load(response.data);

    const list = $('dd')
        .toArray()
        .map((publication) => {
            const itemTitle = $(publication).find('a').first().text().trim();
            const filename = $(publication).find('b').attr('id');
            if (!itemTitle || !filename) {
                return null;
            }
            return {
                title: itemTitle,
                link: `https://cnki.net/kcms/detail/detail.aspx?filename=${filename}&dbcode=CJFD`,
                pubDate: date,
            };
        })
        .filter(Boolean)
        .slice(0, limit);

    if (list.length === 0) {
        throw new Error('cnki: no papers parsed from domestic');
    }

    const items = await Promise.all(list.map((item) => cache.tryGet(item.link, () => ProcessItem(item))));

    return {
        title: String(title),
        link: journalUrl,
        item: items,
    };
}

async function handler(ctx) {
    const name = ctx.req.param('name');
    const forced = ctx.req.query('host');
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 30;

    if (forced === 'oversea') {
        return await fetchOversea(name, limit);
    }

    try {
        const rssUrl = `https://rss.cnki.net/kns/rss.aspx?Journal=${name}&Virtual=knavi`;
        const rssResponse = await got.get(rssUrl);
        const feed = await parser.parseString(rssResponse.data);

        if (feed.items && feed.items.length !== 0) {
            return {
                title: feed.title!,
                link: feed.link,
                description: feed.description,
                item: feed.items.map((item) => ({
                    title: item.title!,
                    description: item.content,
                    pubDate: parseDate(item.pubDate!),
                    link: item.link,
                    author: item.author,
                })),
            };
        }
    } catch (error) {
        logger.error(`cnki: native feed failed - ${(error as Error).message}`);
    }

    try {
        return await fetchDomestic(name, limit);
    } catch (error) {
        logger.error(`cnki: domestic failed - ${(error as Error).message}`);
        if (forced === 'domestic') {
            throw error;
        }
    }

    return await fetchOversea(name, limit);
}
