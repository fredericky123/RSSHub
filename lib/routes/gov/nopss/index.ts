import { load } from 'cheerio';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import { parseDate } from '@/utils/parse-date';
import timezone from '@/utils/timezone';

export const route: Route = {
    path: '/:path{.+}?',
    name: '通用',
    example: '/gov/nopss/GB/219469',
    parameters: { path: '路径，默认为通知公告' },
    radar: [
        {
            source: ['www.nopss.gov.cn/*path/index.html', 'www.nopss.gov.cn/*path'],
            target: '/:path',
        },
    ],
    maintainers: ['nczitzk', 'fredericky123'],
    handler,
    description: `::: tip

路径处填写对应页面 URL 中 \`http://www.nopss.gov.cn/\` 后的字段。下面是一个例子。

若订阅 [年度项目、青年项目和西部项目](http://www.nopss.gov.cn/GB/219469/431027) 则将对应页面 URL <http://www.nopss.gov.cn/GB/219469/431027> 中 \`http://www.nopss.gov.cn/\` 后的字段 \`GB/219469/431027\` 作为路径填入。此时路由为 [\`/gov/nopss/GB/219469/431027\`](https://rsshub.app/gov/nopss/GB/219469/431027)

:::`,
};

async function handler(ctx) {
    const { path = 'GB/219469' } = ctx.req.param();

    const rootUrl = 'http://www.nopss.gov.cn';
    const currentUrl = `${rootUrl}/${path}`;

    const response = await got({
        method: 'get',
        url: currentUrl,
    });

    const $ = load(response.data);

    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 40;

    // Article links follow the people.cn pattern, e.g.
    // /n1/2026/0603/c431027-40733372.html — match on that instead of the
    // (redesign-fragile) list container class. Works for both the aggregated
    // 通知公告 portal page and individual sub-column pages.
    const seen = new Set();
    let items = $('a[href]')
        .toArray()
        .map((item) => {
            const $item = $(item);
            const href = $item.attr('href') ?? '';
            const link = href.startsWith('http') ? href : `${rootUrl}${href.startsWith('/') ? '' : '/'}${href}`;
            return { $item, href, link };
        })
        .filter(({ href }) => /\/n1\/\d{4}\/\d{4}\/c\d+-\d+\.html$/.test(href))
        .filter(({ link }) => {
            if (seen.has(link)) {
                return false;
            }
            seen.add(link);
            return true;
        })
        .slice(0, limit)
        .map(({ $item, link }) => {
            const block = $item.closest('li');
            const dateMatch = (block.length ? block : $item.parent()).text().match(/\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?/);

            return {
                title: $item.text().trim(),
                link,
                pubDate: dateMatch ? timezone(parseDate(dateMatch[0]), 8) : undefined,
            };
        });

    items = await Promise.all(
        items.map((item) =>
            cache.tryGet(item.link, async () => {
                const detailResponse = await got({
                    method: 'get',
                    url: item.link,
                });

                const content = load(detailResponse.data);

                item.description = content('.text_con').html() || content('.show_text').html() || content('#detail_content').html() || item.title;

                return item;
            })
        )
    );

    return {
        title: $('title').text(),
        link: currentUrl,
        item: items,
    };
}
