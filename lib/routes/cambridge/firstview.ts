import { load } from 'cheerio';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

const baseUrl = 'https://www.cambridge.org';

export const route: Route = {
    name: 'Journal FirstView',
    maintainers: ['fredericky123'],
    path: '/journals/:journal/firstview',
    example: '/cambridge/journals/management-and-organization-review/firstview',
    categories: ['journal'],
    parameters: {
        journal: 'Journal slug, found in the URL `cambridge.org/core/journals/<journal>/firstview`, e.g. `management-and-organization-review`.',
    },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: true,
    },
    radar: [
        {
            source: ['cambridge.org/core/journals/:journal/firstview'],
            target: '/journals/:journal/firstview',
        },
    ],
    url: 'cambridge.org',
    description: 'FirstView (online-first) articles of a Cambridge Core journal, with abstracts.',
    handler,
};

async function handler(ctx) {
    const { journal } = ctx.req.param();
    const listUrl = `${baseUrl}/core/journals/${journal}/firstview`;

    const $ = load(await ofetch(listUrl));

    // Title links are the only anchors that point at /journals/<slug>/article/...
    // (author -> /search, PDF -> /content/view/..., reader -> /product/.../core-reader),
    // so this is stable even though Cambridge's CSS class names are not.
    const seen = new Set();
    const list = [];
    $('a[href*="/article/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || !href.includes('/journals/') || seen.has(href)) {
            return;
        }
        const title = $(el).text().trim();
        if (!title) {
            return;
        }
        seen.add(href);
        list.push({ title, link: new URL(href, baseUrl).href });
    });

    const items = await Promise.all(
        list.slice(0, 30).map((item) =>
            cache.tryGet(item.link, async () => {
                const $$ = load(await ofetch(item.link));

                const authors = $$('meta[name="citation_author"]')
                    .toArray()
                    .map((el) => $$(el).attr('content'))
                    .filter(Boolean)
                    .join(', ');

                const abstract = $$('meta[name="citation_abstract"]').attr('content') || $$('.abstract').html() || $$('meta[name="description"]').attr('content') || '';
                const pdf = $$('meta[name="citation_pdf_url"]').attr('content');
                const date = $$('meta[name="citation_online_date"]').attr('content') || $$('meta[name="citation_publication_date"]').attr('content');

                return {
                    title: $$('meta[name="citation_title"]').attr('content') || item.title,
                    link: item.link,
                    description: pdf ? `${abstract}<p><a href="${pdf}">PDF</a></p>` : abstract,
                    author: authors || undefined,
                    doi: $$('meta[name="citation_doi"]').attr('content'),
                    pubDate: date ? parseDate(date) : undefined,
                };
            })
        )
    );

    return {
        title: $('title').first().text().trim() || `${journal} - FirstView`,
        link: listUrl,
        item: items,
        description: `Cambridge Core FirstView articles for ${journal}`,
    };
}
