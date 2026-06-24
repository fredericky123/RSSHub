import type { Route } from '@/types';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import timezone from '@/utils/timezone';

const baseUrl = 'https://libone.bnu.edu.cn';

// Site-wide "detail viewer" page id. Internal articles open at
// /entry/v2/sub/<DETAIL_SUB>?typeId=<t>&dataId=<publicId>#/
// (different from the list page's own sub id). If another column's detail page
// uses a different sub id, change this constant.
const DETAIL_SUB = 'e3cac60df9f07854af2dd485b0900866';

export const route: Route = {
    name: 'Column',
    maintainers: ['fredericky123'],
    path: '/data/:e/:t/:limit?',
    example: '/bnulib/data/09987d1d7966b311ef1827d0037a5ca1819e/1df13a975966b111ef2842655b4f787b0f81',
    categories: ['university'],
    parameters: {
        e: 'Engine key — the `e=` value in the column listing API request (DevTools › Network › request `type/datas`).',
        t: 'Type id — the `t=` value, which equals the `typeId` in the page URL.',
        limit: 'Number of items, 20 by default.',
    },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    url: 'libone.bnu.edu.cn',
    description: '北京师范大学图书馆 libone 栏目列表（通知公告、资源动态等）。',
    handler,
};

async function handler(ctx) {
    const { e, t, limit = '20' } = ctx.req.param();

    // Single request: the column list comes straight from the JSON API.
    const apiUrl = `${baseUrl}/engine2/data/api-v2/0/type/datas?e=${e}&t=${t}&ap=${limit}&sw=&p2=${limit}&p=1&nv=false&m=0`;

    const res = await ofetch(apiUrl);
    const list = res?.data?.datas?.datas ?? [];

    const items = list.map((d) => {
        const title = d['1']?.value;
        const date = d['6']?.value;
        const cover = d['0']?.value;

        // External / WeChat / proxied items carry their own url; internal
        // articles open in the site's detail viewer keyed by publicId.
        const link = d.url ? new URL(d.url, baseUrl).href : `${baseUrl}/entry/v2/sub/${DETAIL_SUB}?typeId=${t}&dataId=${d.publicId}#/`;

        const description = [cover ? `<img src="${cover}">` : '', title].filter(Boolean).join('<br>');

        return {
            title,
            link,
            description,
            guid: d.publicId || link,
            pubDate: date ? timezone(parseDate(date), +8) : undefined,
        };
    });

    return {
        title: '北京师范大学图书馆',
        link: `${baseUrl}/entry/v2/sub/?typeId=${t}`,
        item: items,
        description: `北京师范大学图书馆 libone 栏目 ${t}`,
    };
}
