import { load } from 'cheerio';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import logger from '@/utils/logger';
import md5 from '@/utils/md5';
import { parseDate } from '@/utils/parse-date';
import parser from '@/utils/rss-parser';

import { ProcessItem } from './utils';

const rootUrl = 'https://navi.cnki.net';

export const route: Route = {
    path: '/journals/:name',
    categories: ['journal'],
    example: '/cnki/journals/LKGP',
    parameters: { name: '期刊缩写，可以在网址中得到' },
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
    ],
    name: '期刊',
    maintainers: ['Fatpandac', 'Derekmini', 'pseudoyu'],
    handler,
};

async function handler(ctx) {
    const name = ctx.req.param('name');
    const rssUrl = `https://rss.cnki.net/kns/rss.aspx?Journal=${name}&Virtual=knavi`;

    try {
        // rss.cnki.net 这个子域经常在 TCP 连接阶段就超时/不可达（尤其从境外出口）。
        // 必须把请求放进 try 内并快速失败（短超时、不重试），否则异常会在进入下方
        // 兜底逻辑之前抛出，导致整条路由直接 503，而不是退回 navi.cnki.net 抓取。
        const rssResponse = await got.get(rssUrl, {
            timeout: 8000,
            retry: 0,
        });

        const feed = await parser.parseString(rssResponse.data);

        if (feed.items && feed.items.length !== 0) {
            const items = feed.items.map((item) => ({
                title: item.title,
                description: item.content,
                pubDate: parseDate(item.pubDate),
                link: item.link,
                author: item.author,
                // rss.cnki.net 返回的文章链接带有每次请求都会重新生成的 v= 签名令牌。
                // 若不显式设置 guid，RSSHub 会退回用 link 充当 guid，于是同一篇文章在
                // 每次抓取时 guid 都不同，阅读器（如 Folo）会把它当成全新条目反复推送。
                // 这里用「期刊名 + 标题 + 作者」生成稳定 guid 作为去重键。
                guid: md5(`${name}-${item.title ?? ''}-${item.author ?? ''}`),
            }));

            return {
                title: feed.title,
                link: feed.link,
                description: feed.description,
                item: items,
            };
        }
    } catch (error) {
        logger.error(error);
    }

    // —— 兜底：rss.cnki.net 不可用（超时、被挡、或返回空）时，改抓 navi.cnki.net ——
    // 这一分支的 link 用稳定的 filename 拼接，天然没有 v= 令牌问题，guid 也稳定。
    const journalUrl = `${rootUrl}/knavi/journals/${name}/detail`;
    const titleRes = await got.get(journalUrl);
    const title = load(titleRes.data)('head > title').text();

    const yearListUrl = `${rootUrl}/knavi/journals/${name}/yearList?pIdx=0`;

    const yearListRes = await got.get(yearListUrl);
    const $yearList = load(yearListRes.data);
    const code = $yearList('.yearissuepage').find('dl').first().find('dd').find('a').first().attr('value');
    const date = parseDate($yearList('.yearissuepage').find('dl').first().find('dd').find('a').first().attr('id').replace('yq', ''), 'YYYYMM');

    const yearIssueUrl = `${rootUrl}/knavi/journals/${name}/papers?yearIssue=${code}&pageIdx=0&pcode=CJFD,CCJD`;
    const response = await got.post(yearIssueUrl);

    const $ = load(response.data);
    const publications = $('dd');

    const list = publications.toArray().map((publication) => {
        const title = $(publication).find('a').first().text();
        const filename = $(publication).find('b').attr('id');
        const link = `https://cnki.net/kcms/detail/detail.aspx?filename=${filename}&dbcode=CJFD`;

        return {
            title,
            link,
            pubDate: date,
        };
    });

    const items = await Promise.all(list.map((item) => cache.tryGet(item.link, () => ProcessItem(item))));

    return {
        title: String(title),
        link: journalUrl,
        item: items,
    };
}
