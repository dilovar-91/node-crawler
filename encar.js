const puppeteer = require('puppeteer');
const fs = require('fs');
const translate = require('google-translate-api');

(async () => {
  const url = 'https://fem.encar.com/cars/detail/40036464?pageid=mt_carlist&listAdvType=mt&carid=40036464&view_type=hs_ad&adv_attribute=hs_ad';

  console.log('🚗 Запуск браузера...');
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });

  console.log('📸 Извлекаем галерею...');
  const gallery = await page.evaluate(() => {
    const imgs = [];
    document.querySelectorAll('.swiper-slide img').forEach(img => {
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      if (src && src.includes('ci.encar.com')) {
        imgs.push(src.startsWith('http') ? src : 'https:' + src);
      }
    });
    return [...new Set(imgs)]; // убираем дубликаты
  });

  console.log('⚙️ Извлекаем основные характеристики...');
  const specs = await page.evaluate(() => {
    const data = {};
    document.querySelectorAll('.detail_info .info_area li').forEach(li => {
      const key = li.querySelector('.tit')?.innerText?.trim();
      const value = li.querySelector('.desc')?.innerText?.trim();
      if (key && value) data[key] = value;
    });
    return data;
  });

  console.log('🧩 Извлекаем опции...');
  const options = await page.evaluate(() => {
    const list = [];
    document.querySelectorAll('#detailOption .DetailOption_list_option__kTYgR li').forEach(li => {
      const text = li.innerText.replace(/\s+/g, ' ').trim();
      if (text) list.push(text);
    });
    return list;
  });

  console.log('💬 Извлекаем "Рекомендации продавца"...');
  const recommendation = await page.evaluate(() => {
    const text = document.querySelector('.DetailRecommend_desc__f4S8B')?.innerText?.trim();
    return text || '';
  });

  // ===== Перевод на русский =====
  async function tr(text) {
    try {
      const res = await translate(text, { to: 'ru' });
      return res.text;
    } catch {
      return text;
    }
  }

  console.log('🌐 Переводим данные...');
  const translatedSpecs = {};
  for (const [key, value] of Object.entries(specs)) {
    translatedSpecs[await tr(key)] = await tr(value);
  }

  const translatedOptions = [];
  for (const opt of options) {
    translatedOptions.push(await tr(opt));
  }

  const translatedRecommendation = await tr(recommendation);

  // ===== Формируем результат =====
  const result = {
    url,
    gallery,
    specs: translatedSpecs,
    options: translatedOptions,
    recommendation: translatedRecommendation,
  };

  // Сохраняем в файл
  fs.writeFileSync('encar_result.json', JSON.stringify(result, null, 2), 'utf8');
  console.log('✅ Сохранено в encar_result.json');
  console.log(result);

  await browser.close();
})();
