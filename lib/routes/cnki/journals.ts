import { load } from 'cheerio';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import parser from '@/utils/rss-parser';

import { ProcessItem } from './utils';

// navi/rss.cnki.net only answer to mainland China IPs; oversea.cnki.net serves
// the same journal via a different markup and link scheme.
const DOMESTIC_ROOT = 'https://navi.cnki.net';
const OVERSEA_ROOT = 'https://oversea.cnki.net';

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
| 强制境内 | \`/cnki/journals/GLSJ?host=domestic\` |

境外站点的作者、页码直接来自目录页，无需逐篇抓取，因此响应很快。`,
    handler,
};

// ---------- oversea ----------

async function fetchOversea(name: string, limit: number) {
    const journalUrl = `${OVERSEA_ROOT}/knavi/journals/${name}/detail?language=CHS`;
    const titleRes = await got.get(journalUrl);
    const title = load(titleRes.data)('head > title').text().trim();

    // Without yearIssue the endpoint returns the latest issue, which is what a
    // feed wants (the oversea yearIssue value is an opaque encrypted token).
    const papersUrl = `${OVERSEA_ROOT}/knavi/journals/${name}/papers?pageIdx=0&pcode=CJFD,CCJD&isEpublish=0&language=CHS&uniplatform=OVERSEA`;
    const papersRes = await got.get(papersUrl);
    const $ = load(papersRes.data);

    const items = $('dd')
        .toArray()
        .map((el) => {
            const $el = $(el);
            const $a = $el.find('span.name > a').first();
            const itemTitle = $a.text().trim();
            const link = $a.attr('href');
            if (!itemTitle || !link) {
                return null;
            }

            // e.g. GLSJ202607002 -> issue 2026-07
            const fileId = $el.find('b[name="encrypt"]').attr('id') || '';
            const ym = fileId.match(/[A-Z]+(\d{4})(\d{2})/i);

            const author = ($el.find('span.author').attr('title') || $el.find('span.author').text()).replace(/;$/, '').replaceAll(';', ', ').trim();
            const pages = ($el.find('span.company').attr('title') || $el.find('span.company').text()).trim();
            // Section heading (重大选题征文 / 经济学 / 工商管理 ...)
            const section = $el.parent().find('dt.tit').first().text().trim();

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

    if (items.length === 0) {
        throw new Error('cnki: no papers parsed from oversea');
    }

    return {
        title: title || `CNKI - ${name}`,
        link: journalUrl,
        item: items,
    };
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

    // The native CNKI feed is mainland-only.
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
