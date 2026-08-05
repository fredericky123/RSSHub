import { load } from 'cheerio';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import parser from '@/utils/rss-parser';

import { ProcessItem } from './utils';

// navi/rss.cnki.net only answer to mainland China IPs; oversea.cnki.net serves
// the same knavi endpoints to everyone else (it needs language=CHS).
const HOSTS = {
    domestic: {
        root: 'https://navi.cnki.net',
        article: 'https://cnki.net',
        lang: '',
    },
    oversea: {
        root: 'https://oversea.cnki.net',
        article: 'https://oversea.cnki.net',
        lang: 'language=CHS',
    },
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
    description: `默认自动选择站点：先尝试境内 \`navi.cnki.net\`，失败则回退到境外 \`oversea.cnki.net\`，因此境内、境外服务器均可使用。

也可用 \`?host=\` 手动指定，跳过探测、加快响应：

| 场景 | 订阅地址 |
| --- | --- |
| 自动 | \`/cnki/journals/GLSJ\` |
| 强制境内 | \`/cnki/journals/GLSJ?host=domestic\` |
| 强制境外 | \`/cnki/journals/GLSJ?host=oversea\` |`,
    handler,
};

// Build a knavi URL for the given host, appending language=CHS for oversea.
function withLang(url: string, lang: string) {
    if (!lang) {
        return url;
    }
    return url.includes('?') ? `${url}&${lang}` : `${url}?${lang}`;
}

async function fetchFromHost(name: string, key: string) {
    const host = HOSTS[key];

    const journalUrl = withLang(`${host.root}/knavi/journals/${name}/detail`, host.lang);
    const titleRes = await got.get(journalUrl);
    const title = load(titleRes.data)('head > title').text();

    const yearListUrl = withLang(`${host.root}/knavi/journals/${name}/yearList?pIdx=0`, host.lang);
    const yearListRes = await got.get(yearListUrl);
    const $yearList = load(yearListRes.data);

    const firstIssue = $yearList('.yearissuepage').find('dl').first().find('dd').find('a').first();
    const code = firstIssue.attr('value');
    const issueId = firstIssue.attr('id');
    if (!code || !issueId) {
        throw new Error(`cnki: cannot read issue list from ${key}`);
    }
    const date = parseDate(issueId.replace('yq', ''), 'YYYYMM');

    const yearIssueUrl = withLang(`${host.root}/knavi/journals/${name}/papers?yearIssue=${code}&pageIdx=0&pcode=CJFD,CCJD`, host.lang);
    const response = await got.post(yearIssueUrl);

    const $ = load(response.data);
    const list = $('dd')
        .toArray()
        .map((publication) => {
            const itemTitle = $(publication).find('a').first().text();
            const filename = $(publication).find('b').attr('id');
            return {
                title: itemTitle,
                link: `${host.article}/kcms/detail/detail.aspx?filename=${filename}&dbcode=CJFD`,
                pubDate: date,
            };
        })
        .filter((item) => item.title);

    if (list.length === 0) {
        throw new Error(`cnki: no papers parsed from ${key}`);
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

    // The native CNKI feed is mainland-only; skip it when oversea is forced.
    if (forced !== 'oversea') {
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
            logger.error(error);
        }
    }

    // Fall back through the hosts: domestic first unless told otherwise, so the
    // same route works from a China server and from an overseas one.
    const order = forced === 'oversea' ? ['oversea'] : (forced === 'domestic' ? ['domestic'] : ['domestic', 'oversea']);

    let lastError;
    for (const key of order) {
        try {
            return await fetchFromHost(name, key);
        } catch (error) {
            logger.error(`cnki: ${key} failed - ${(error as Error).message}`);
            lastError = error;
        }
    }
    throw lastError;
}
