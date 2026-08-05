import { load } from 'cheerio';

import type { Route } from '@/types';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import puppeteer from '@/utils/puppeteer';

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
    name: '期刊（境外站，需 Puppeteer）',
    maintainers: ['fredericky123'],
    url: 'oversea.cnki.net',
    description: `境外站 \`oversea.cnki.net\` 的期次 token 由页面 JS 运行时加密生成，纯 HTTP 抓取无法获得，因此本路由使用 Puppeteer 渲染页面后再取数据。

**需要常驻实例**（VPS / Railway / Docker），Vercel 等 Serverless 环境通常因体积与冷启动限制无法运行。境内服务器请改用 \`/cnki/journals/:name\`。`,
    handler,
};

async function handler(ctx) {
    const name = ctx.req.param('name');
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 30;
    const journalUrl = `${OVERSEA_ROOT}/knavi/journals/${name}/detail?language=CHS`;

    const browser = await puppeteer();
    let papersHtml = '';
    let title = '';

    try {
        const page = await browser.newPage();

        // Block heavy assets: we only need the DOM and the XHR responses.
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const type = request.resourceType();
            if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') {
                request.abort();
            } else {
                request.continue();
            }
        });

        logger.http(`Requesting ${journalUrl}`);
        await page.goto(journalUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        title = await page.title();

        // The issue list is injected by JS; wait for an issue token to appear.
        await page.waitForFunction(() => /yearIssue=[\w-]{60,}|GetIssue\(['"][\w-]{60,}/.test(document.documentElement.innerHTML) || document.querySelectorAll('dl.yearissuepage a, .yearissuepage a, a[id^="yq"]').length > 0, { timeout: 30000 }).catch(() => logger.error('cnki: issue list did not appear in time'));

        // Pull the newest issue token straight out of the rendered DOM, then
        // fetch the paper list from inside the page so the session, cookies and
        // encrypted context all match what the site itself would send.
        papersHtml = await page.evaluate(async (pcode) => {
            const html = document.documentElement.innerHTML;

            const grab = () => {
                const direct = html.match(/yearIssue=([\w-]{60,})/)?.[1];
                if (direct) {
                    return direct;
                }
                const called = html.match(/GetIssue\(\s*['"]([\w-]{60,})['"]/)?.[1];
                if (called) {
                    return called;
                }
                for (const el of document.querySelectorAll('[value]')) {
                    const v = el.getAttribute('value') || '';
                    if (v.length > 60) {
                        return v;
                    }
                }
                return '';
            };

            const token = grab();
            if (!token) {
                return '';
            }

            const url = `/knavi/journals/${location.pathname.split('/')[3]}/papers?yearIssue=${token}&pageIdx=0&pcode=${pcode}&isEpublish=0&language=CHS&uniplatform=OVERSEA`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            return await res.text();
        }, 'CJFD,CCJD');

        await page.close();
    } finally {
        browser.close();
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
