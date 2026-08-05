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
        const result = await page.evaluate(async (journalName) => {
            const html = document.documentElement.innerHTML;

            // Collect every plausible issue token, newest first.
            const found = new Set<string>();
            for (const m of html.matchAll(/yearIssue=([\w-]{60,})/g)) {
                found.add(m[1]);
            }
            for (const m of html.matchAll(/GetIssue\(\s*['"]([\w-]{60,})['"]/g)) {
                found.add(m[1]);
            }
            for (const el of document.querySelectorAll('[value]')) {
                const v = el.getAttribute('value') || '';
                if (v.length > 60) {
                    found.add(v);
                }
            }
            // Last resort: any long token family on the page.
            if (found.size === 0) {
                const all = html.match(/[A-Za-z0-9_-]{100,200}/g) || [];
                const groups = new Map();
                for (const t of all) {
                    const k = t.slice(0, 40);
                    groups.set(k, [...(groups.get(k) || []), t]);
                }
                const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
                for (const t of best.slice(0, 5)) {
                    found.add(t);
                }
            }

            const tokens = [...found];
            const tried = [];

            for (const token of tokens.slice(0, 5)) {
                const url = `/knavi/journals/${journalName}/papers?yearIssue=${token}&pageIdx=0&pcode=CJFD,CCJD&isEpublish=0&language=CHS&uniplatform=OVERSEA`;
                const res = await fetch(url, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
                const text = await res.text();
                tried.push(`${token.slice(0, 10)}:${res.status}:${text.length}`);
                if (text.includes('span class="name"') || text.length > 5000) {
                    return { html: text, tokens: tokens.length, tried, htmlLen: html.length };
                }
            }

            return { html: '', tokens: tokens.length, tried, htmlLen: html.length };
        }, name);

        logger.error(`cnki: rendered=${result.htmlLen} bytes, tokens=${result.tokens}, tried=[${result.tried.join(' | ')}]`);
        papersHtml = result.html;
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
