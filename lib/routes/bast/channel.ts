import { load } from 'cheerio';

import type { Route } from '@/types';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

const baseUrl = 'https://www.bast.net.cn';

const channelNames = {
    tzgg: '通知公告',
    zfcg: '政府采购',
    kxyw: '科协要闻',
};

export const route: Route = {
    name: 'Channel',
    maintainers: ['fredericky123'],
    path: '/sy/:channel',
    example: '/bast/sy/tzgg',
    categories: ['government'],
    parameters: {
        channel: 'Channel id from the URL `bast.net.cn/sy/<channel>/`, e.g. `tzgg` (通知公告), `zfcg` (政府采购), `kxyw` (科协要闻).',
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
            source: ['bast.net.cn/sy/:channel'],
            target: '/sy/:channel',
        },
    ],
    url: 'bast.net.cn',
    description: '北京市科学技术协会 列表栏目（通知公告、政府采购、科协要闻等）。',
    handler,
};

async function handler(ctx) {
    const { channel } = ctx.req.param();
    const listUrl = `${baseUrl}/sy/${channel}/`;

    // Single request: the list page is server-rendered, so no per-article fetch.
    const $ = load(await ofetch(listUrl));

    const items = [];
    const seen = new Set();

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        // Article links look like .../t20260624_183082.html — the 8 digits are the date.
        const m = href.match(/\/t(\d{8})_\d+\.html$/);
        if (!m) {
            return;
        }
        const link = new URL(href, listUrl).href;
        if (seen.has(link)) {
            return;
        }
        seen.add(link);

        const $li = $(el).closest('li');
        const title = ($(el).attr('title') || $(el).text() || $li.find('a[title]').first().attr('title') || '').trim();
        if (!title) {
            return;
        }

        // The excerpt is the longest sibling link text in the same item.
        let description = '';
        $li.find('a').each((__, a) => {
            const t = $(a).text().trim();
            if (t && t !== title && t.length > description.length) {
                description = t;
            }
        });

        items.push({
            title,
            link,
            description: description || title,
            pubDate: parseDate(m[1], 'YYYYMMDD'),
        });
    });

    return {
        title: `北京市科学技术协会 - ${channelNames[channel] || channel}`,
        link: listUrl,
        item: items,
        description: `北京市科学技术协会 ${channelNames[channel] || channel}`,
    };
}
