import { load } from 'cheerio';

import type { Route } from '@/types';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import { getPlaywrightPage } from '@/utils/playwright';

const OVERSEA_ROOT = 'https://oversea.cnki.net';

export const route: Route = {
    path: '/journals-oversea/:name',
    categories: ['journal'],
    example: '/cnki/journals-oversea/GLSJ',
    parameters: {
        name: '期刊缩写，可在网址中得到，如 `GLSJ`（管理世界）',
    },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: '期刊（境外站，需浏览器渲染）',
    maintainers: ['fredericky123'],
    url: 'oversea.cnki.net',
    description: `境外站 \`oversea.cnki.net\` 的期次 token 由页面 JS 运行时加密生成，纯 HTTP 抓取无法获得，因此本路由渲染页面后再取数据。

**需要常驻实例**（VPS / Railway / Docker），Serverless 环境通常因体积与冷启动限制无法运行。境内服务器请改用 \`/cnki/journals/:name\`。`,
    handler,
};

async function handler(ctx) {
    const name = ctx.req.param('name');
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 30;
    const journalUrl = `${OVERSEA_ROOT}/knavi/journals/${name}/detail?language=CHS`;

    logger.http(`Requesting ${journalUrl}`);
    const { page, destroy } = await getPlaywrightPage(journalUrl, {
        gotoConfig: { waitUntil: 'networkidle', timeout: 60000 },
    });

    let papersHtml = '';
    let title = '';

    try {
        title = await page.title();

        // The issue list is injected by JS; wait until a token shows up.
        await page
            .waitForFunction(() => /yearIssue=[\w-]{60,}|GetIssue\(['"][\w-]{60,}/.test(document.documentElement.innerHTML) || [...document.querySelectorAll('[value]')].some((el) => (el.getAttribute('value') || '').length > 60), { timeout: 30000 })
            .catch(() => logger.error('cnki: issue list did not appear in time'));

        // Read the newest issue token from the rendered DOM, then request the
        // paper list from inside the page so session, cookies and the encrypted
        // context all match what the site itself sends.
        papersHtml = await page.evaluate(async (journalName) => {
            const html = document.documentElement.innerHTML;

            const token =
                html.match(/yearIssue=([\w-]{60,})/)?.[1] ||
                html.match(/GetIssue\(\s*['"]([\w-]{60,})['"]/)?.[1] ||
                [...document.querySelectorAll('[value]')].map((el) => el.getAttribute('value') || '').find((v) => v.length > 60) ||
                '';

            if (!token) {
                return '';
            }

            const url = `/knavi/journals/${journalName}/papers?yearIssue=${token}&pageIdx=0&pcode=CJFD,CCJD&isEpublish=0&language=CHS&uniplatform=OVERSEA`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            return await res.text();
        }, name);
    } finally {
        await destroy();
    }

    if (!papersHtml) {
        throw new Error('cnki: could not obtain issue token from the rendered page');
    }

    const $ = load(papersHtml);
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

    if (items.length === 0) {
        throw new Error('cnki: no papers parsed from the rendered page');
    }

    return {
        title: title || `CNKI - ${name}`,
        link: journalUrl,
        item: items,
    };
}
