import { load } from 'cheerio';

import type { Route } from '@/types';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

const baseUrl = 'https://jsgzb.bnu.edu.cn';

const channelNames = {
    tzgg: '通知公告',
};

export const route: Route = {
    name: 'Channel',
    maintainers: ['fredericky123'],
    path: '/:channel?',
    example: '/bnujsgzb/tzgg',
    categories: ['university'],
    parameters: {
        channel: 'Channel id from the URL `jsgzb.bnu.edu.cn/<channel>/index.html`, `tzgg` (通知公告) by default.',
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
            source: ['jsgzb.bnu.edu.cn/:channel/index.html', 'jsgzb.bnu.edu.cn/:channel'],
            target: '/:channel',
        },
    ],
    url: 'jsgzb.bnu.edu.cn',
    description: '北京师范大学党委教师工作部（教师发展中心）列表栏目，默认通知公告。',
    handler,
};

async function handler(ctx) {
    const { channel = 'tzgg' } = ctx.req.param();
    const listUrl = `${baseUrl}/${channel}/index.html`;

    // Single request: the list page is server-rendered.
    const $ = load(await ofetch(listUrl));

    const items = [];
    const seen = new Set();

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        // Article links are /<channel>/<32-hex>.html ; this skips index/nav/外链.
        if (!/\/[0-9a-f]{20,}\.html$/i.test(href)) {
            return;
        }
        const link = new URL(href, listUrl).href;
        if (seen.has(link)) {
            return;
        }
        const title = $(el).text().trim();
        if (!title) {
            return;
        }
        seen.add(link);

        // The date (YYYY-MM-DD) sits in the same list item as the title.
        const container = $(el).closest('li');
        const block = container.length ? container : $(el).parent();
        const dateMatch = block.text().match(/\d{4}-\d{2}-\d{2}/);

        items.push({
            title,
            link,
            description: title,
            pubDate: dateMatch ? parseDate(dateMatch[0]) : undefined,
        });
    });

    return {
        title: `北京师范大学党委教师工作部 - ${channelNames[channel] || channel}`,
        link: listUrl,
        item: items,
        description: `北京师范大学党委教师工作部 ${channelNames[channel] || channel}`,
    };
}
