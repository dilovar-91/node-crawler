const puppeteer = require('puppeteer');
const fs = require('fs');


(async () => {
  // === динамический импорт, чтобы работало в CommonJS ===
  const { default: translate } = await import('@vitalets/google-translate-api');
   const { default: pLimit } = await import('p-limit');

  

  const url = 'https://fem.encar.com/cars/detail/40036464?pageid=mt_carlist&listAdvType=mt&carid=40036464&view_type=hs_ad&adv_attribute=hs_ad';

  // Троттлинг одновременных запросов к переводчику
  const limit = pLimit(2);

  // Универсальный переводчик с ретраями
  async function tr(text, to = 'ru', retries = 3) {
    if (!text) return '';
    for (let i = 0; i < retries; i++) {
      try {
        const res = await translate(text, { to });
        return res.text;
      } catch (e) {
        // 429/5xx: подождём и попробуем снова
        const delay = 500 * (i + 1);
        await new Promise(r => setTimeout(r, delay));
        if (i === retries - 1) return text; // последнее — отдаём оригинал
      }
    }
    return text;
  }

  // батч-перевод массива строк с ограничением параллельности
  async function trBatch(arr, delay = 300) {
  const results = [];
  for (const s of arr) {
    results.push(await tr(s));
    await new Promise(r => setTimeout(r, delay)); // пауза между запросами
  }
  return results;
}

  console.log('🚗 Стартуем Puppeteer…');
  const browser = await puppeteer.launch({ headless: false,  defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'], });
  const page = await browser.newPage();

  // Немного “человечности”
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  );

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

  // Иногда галерея/опции подгружаются — проскроллим и дадим время lazy-load
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  //await page.waitForTimeout(1000);

  //await setTimeout(1000);

  console.log('📸 Парсим галерею…');
  const gallery = await page.evaluate(() => {
  const imgs = new Set();
  document.querySelectorAll('.swiper-slide img').forEach(img => {
    let src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src) return;
    if (src.startsWith('/')) src = 'https:' + src;
    if (src.includes('carpicture') || src.includes('ci.encar.com')) {
      // убираем лишние параметры ?impolicy=...
      src = src.split('?')[0];
      imgs.add(src);
    }
  });
  return Array.from(imgs);
});

  console.log('⚙️ Парсим характеристики…');
  // Под разные разметки делаем несколько селекторов
  const specs = await page.evaluate(() => {
    const data = {};

    // Вариант 1: старая разметка
    document.querySelectorAll('.detail_info .info_area li').forEach(li => {
      const key = li.querySelector('.tit')?.innerText?.trim();
      const val = li.querySelector('.desc')?.innerText?.trim();
      if (key && val) data[key] = val;
    });

    // Вариант 2: новая карточная разметка (если есть)
    document.querySelectorAll('[class*="Spec"] li, [class*="spec"] li').forEach(li => {
      const spans = li.querySelectorAll('span, strong, em, b, i, p, div');
      if (spans.length >= 2) {
        const key = spans[0].textContent.trim();
        const val = spans[1].textContent.trim();
        if (key && val && !data[key]) data[key] = val;
      }
    });

    return data;
  });

  console.log('🧩 Парсим опции…');
  const optionsKorean = await page.evaluate(() => {
    const list = [];

    // Основной блок опций
    document.querySelectorAll('#detailOption .DetailOption_list_option__kTYgR li').forEach(li => {
      const txt = li.textContent.replace(/\s+/g, ' ').trim();
      if (txt) list.push(txt);
    });

    // “Опции этой машины”
    document.querySelectorAll('#detailOption .DetailOption_choose_option__JO8v4 li').forEach(li => {
      const t = li.textContent.replace(/\s+/g, ' ').trim();
      if (t) list.push(t);
    });

    return list;
  });

  console.log('💬 Парсим описание/рекомендацию…');
  const recommendationKo = await page.evaluate(() => {
    const el = document.querySelector('.DetailRecommend_desc__f4S8B') ||
               document.querySelector('[class*="Recommend"] [class*="desc"]');
    return el ? el.textContent.trim() : '';
  });

  console.log('🌐 Переводим на русский…');

  // Перевод ключей/значений характеристик
  const specKeys = Object.keys(specs);
  const specVals = Object.values(specs);

  const [specKeysRu, specValsRu, optionsRu, recommendationRu] = await Promise.all([
    trBatch(specKeys),
    trBatch(specVals),
    trBatch(optionsKorean),
    tr(recommendationKo),
  ]);

  const specsRu = {};
  specKeysRu.forEach((kru, i) => {
    specsRu[kru] = specValsRu[i];
  });

  const result = {
    source_url: url,
    gallery,
    specs: specsRu,
    options: optionsRu,
    recommendation: recommendationRu,
    scraped_at: new Date().toISOString(),
  };

  fs.writeFileSync('encar_result.json', JSON.stringify(result, null, 2), 'utf8');
  console.log('✅ Готово: encar_result.json');
  console.log(result);

  await browser.close();
})();
