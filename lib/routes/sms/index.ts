import { load } from 'cheerio';

import type { Route } from '@/types';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

const baseUrl = 'https://www.strategicmanagement.net';

const categories = {
    news: { title: 'SMS News', path: '/publications-resources/sms-news/' },
    webinars: { title: 'Webinars', path: '/publications-resources/webinars/' },
    events: { title: 'Event Calendar', path: '/conferences-events/event-calendar/' },
};

const DATE_RE = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/;

export const route: Route = {
    path: '/:category?',
    name: 'News / Webinars / Events',
    example: '/sms/news',
    categories: ['journal'],
    parameters: {
        category: 'One of `news` (SMS News), `webinars`, `events` (Event Calendar). Defaults to `news`.',
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
            source: ['www.strategicmanagement.net/publications-resources/sms-news/'],
            target: '/news',
        },
        {
            source: ['www.strategicmanagement.net/publications-resources/webinars/'],
            target: '/webinars',
        },
        {
            source: ['www.strategicmanagement.net/conferences-events/event-calendar/'],
            target: '/events',
        },
    ],
    maintainers: ['fredericky123'],
    url: 'strategicmanagement.net',
    description: `Strategic Management Society (SMS) 动态订阅：

| 栏目 | 路由 |
| --- | --- |
| SMS News | \`/sms/news\` |
| Webinars | \`/sms/webinars\` |
| Event Calendar | \`/sms/events\` |`,
    handler,
};

async function handler(ctx) {
    const category = ctx.req.param('category') ?? 'news';
    const conf = categories[category] ?? categories.news;
    const listUrl = `${baseUrl}${conf.path}`;
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 30;

    // Single request: all three pages are server-rendered.
    const $ = load(await ofetch(listUrl));

    const seen = new Set();
    const items = [];

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        let url;
        try {
            url = new URL(href, listUrl);
        } catch {
            return;
        }
        if (url.hostname !== 'www.strategicmanagement.net') {
            return;
        }

        // Content links are either Explorer articles or Events Calendar entries.
        const isArticle = url.pathname.startsWith('/publications-resources/strategic-management-explorer/');
        const isEvent = url.pathname.startsWith('/event/');
        if (!isArticle && !isEvent) {
            return;
        }
        // Skip the section landing pages themselves.
        if (url.pathname === '/publications-resources/strategic-management-explorer/' || url.pathname === '/event/') {
            return;
        }

        const link = url.href;
        if (seen.has(link)) {
            return;
        }

        // Every title link carries a clean title attribute; fall back to text
        // with any leading date stripped off.
        const rawText = $(el).text().replace(/\s+/g, ' ').trim();
        const title = ($(el).attr('title') || rawText.replace(DATE_RE, '')).trim();
        if (!title) {
            return;
        }

        // The date sits either inside the link text or in a nearby wrapper —
        // walk up a few levels until one matches.
        let dateStr = rawText.match(DATE_RE)?.[0];
        if (!dateStr) {
            let $node = $(el).parent();
            for (let i = 0; i < 4 && $node.length && !dateStr; i++) {
                dateStr = $node.text().replace(/\s+/g, ' ').match(DATE_RE)?.[0];
                $node = $node.parent();
            }
        }

        const location = isEvent ? $(el).closest('li').text().replace(/\s+/g, ' ').match(/Location:\s*([^]*?)(?:View this Event|$)/)?.[1]?.trim() : '';

        seen.add(link);
        items.push({
            title,
            link,
            description: location ? `${title}<br>Location: ${location}` : title,
            pubDate: dateStr ? parseDate(dateStr, 'MMMM D, YYYY') : undefined,
        });
    });

    return {
        title: `SMS - ${conf.title}`,
        link: listUrl,
        item: items.slice(0, limit),
        description: `Strategic Management Society ${conf.title}`,
    };
}
