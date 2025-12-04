import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const https = require("https");
const fs = require("fs");

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json({ limit: "2mb" }));

// 🔒 безопасный клик с ретраями и fallback'ами
async function safeClick(page, selector, opts = {}) {
  const {
    attempts = 1,
    appearTimeout = 8000,
    betweenAttempts = 700,
    clickDelay = 100,
  } = opts;

  let labelSelector = null;
  if (selector.startsWith("#")) {
    const id = selector.slice(1);
    labelSelector = `label[for="${id}"]`;
  }

  for (let tryNum = 1; tryNum <= attempts; tryNum++) {
    try {
      await page.waitForSelector(selector, {
        timeout: appearTimeout,
        visible: true,
      });
      const el = await page.$(selector);
      if (!el) throw new Error("Element handle is null");
      await el.evaluate((n) =>
        n.scrollIntoView({ behavior: "instant", block: "center" })
      );
      await el.click({ delay: clickDelay });
      return true;
    } catch (err) {
      // запасной клик через evaluate
      try {
        const clickedEval = await page.evaluate((sel) => {
          const node = document.querySelector(sel);
          if (!node) return false;
          node.scrollIntoView({ behavior: "instant", block: "center" });
          node.click();
          return true;
        }, selector);
        if (clickedEval) return true;
      } catch {}

      // запасной клик по label
      if (labelSelector) {
        try {
          await page.waitForSelector(labelSelector, {
            timeout: appearTimeout / 2,
            visible: true,
          });
          await page.click(labelSelector, { delay: clickDelay });
          return true;
        } catch {}
      }

      if (tryNum < attempts) {
        console.warn(
          `⚠️ Не удалось кликнуть по ${selector} (попытка ${tryNum}/${attempts}), повтор...`
        );
        await new Promise((r) => setTimeout(r, betweenAttempts));
        continue;
      }

      console.warn(
        `⏭️ Пропускаю ${selector}: все ${attempts} попытки неудачны.`
      );
      return false;
    }
  }
  return false;
}

app.get("/", (req, res) => {
  res.send("Hello World");
});

app.post("/parse", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  try {
    console.log("🔗 Открываю:", url);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 2260000 });

    await page.waitForSelector("._gallery", { timeout: 15000 });

    const compleetes = await page.$$eval(
      ".equipments-select-list-def__item",
      (blocks) =>
        blocks.map((block) => {
          const input = block.querySelector('input[name="compleete"]');
          const name =
            block
              .querySelector(".equipment-select-def__title")
              ?.textContent.trim() || "";
          const price =
            block
              .querySelector(".equipment-select-def__price")
              ?.textContent.trim() || "";
          const value = input?.value || "";
          return { name, price, value };
        })
    );
    let com = 0;
    for (let comp of compleetes) {
      com++;
      if (com > 0) break;
      try {
        console.log("🖱️ Комплектация:", comp.name || comp.value);

        const descriptionHTML = await page.$eval(
          ".product-page-def .block-def",
          (el) => el.outerHTML
        );

        const carName = await page.$eval(
          "h1",
          (el) => el.textContent.trim() || el.value
        );

        comp.carName = carName;

        const clicked = await page.evaluate((v) => {
          const el = document.querySelector(
            `input[name="compleete"][value="${v}"]`
          );
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.click();
            return true;
          }
          return false;
        }, comp.value);

        if (!clicked) {
          console.warn(`⚠️ Комплектация ${comp.value} не найдена, пропускаем`);
          continue;
        }

        await page.waitForSelector(".single__slider", { timeout: 15000 });

        await page.waitForSelector(".properties-list-line-5__item", {
          timeout: 10000,
        });

        const specs = await page.$$eval(
          ".properties-list-line-5__item",
          (items) =>
            items.map((el) => ({
              label:
                el.querySelector(".property-2__label")?.textContent.trim() ||
                "",
              value:
                el.querySelector(".property-2__value")?.textContent.trim() ||
                "",
            }))
        );
        comp.specs = specs;

        // 🎨 Цвета кузова
        const bodyColors = await page.$$eval('input[name="color"]', (inputs) =>
          inputs.reduce((acc, el, i) => {
            if (i === 1) return acc; // stop collecting
            const container = el.closest(".picture-select-def");
            const titleEl = container?.querySelector(
              ".picture-select-def__title"
            );
            const colorEl = container?.querySelector(
              ".picture-select-def__color span"
            );

            acc.push({
              index: i,
              id: el.id,
              name: titleEl?.textContent.trim() || el.value,
              value: el.value,
              price: el.dataset.price || "0",
              colorCode: colorEl?.style.backgroundColor || "",
            });
            return acc;
          }, [])
        );

        comp.items = [];
        comp.accessories = [];
        comp.additional_options = [];

        for (const bodyColor of bodyColors) {
          console.log(`🎨 Цвет кузова: ${bodyColor.name}`);
          const okColor = await safeClick(page, `#${bodyColor.id}`);
          if (!okColor) continue;

          await page.waitForSelector(".single__slider", { timeout: 15000 });

          // 🔘 Колёса
          const wheels = await page.$$eval('input[name="wheel"]', (inputs) =>
            inputs.map((el, i) => {
              const container = el.closest(".picture-select-def");
              const titleEl = container?.querySelector(
                ".picture-select-def__title"
              );
              const imgEl =
                container?.querySelector("picture img") ||
                container?.querySelector(".picture-select-def__body img") ||
                container?.querySelector("img");
              const imgSrc =
                imgEl?.getAttribute("data-src") ||
                imgEl?.currentSrc ||
                imgEl?.src ||
                "";
              return {
                index: i,
                id: el.id,
                name: titleEl?.textContent.trim() || el.value,
                img: imgSrc,
                price: el.dataset.price || "0",
              };
            })
          );

          for (const wheel of wheels) {
            console.log(`🛞 Колёса: ${wheel.name}`);
            const okWheel = await safeClick(page, `#${wheel.id}`);
            if (!okWheel) continue;

            await page.waitForSelector(".single__slider", { timeout: 15000 });

            // 🪑 Интерьеры
            const interiors = await page.$$eval(
              'input[name="interior"]',
              (inputs) =>
                inputs.map((el, i) => {
                  const container = el.closest(".picture-select-def");
                  const titleEl = container?.querySelector(
                    ".picture-select-def__title"
                  );
                  const imgEl =
                    container?.querySelector("picture img") ||
                    container?.querySelector(".picture-select-def__body img") ||
                    container?.querySelector("img");
                  const imgSrc =
                    imgEl?.getAttribute("data-src") ||
                    imgEl?.currentSrc ||
                    imgEl?.src ||
                    "";
                  return {
                    index: i,
                    id: el.id,
                    name: titleEl?.textContent.trim() || el.value,
                    img: imgSrc,
                    price: el.dataset.price || "0",
                  };
                })
            );

            for (const interior of interiors) {
              console.log(`🪑 Интерьер: ${interior.name}`);
              const okInterior = await safeClick(page, `#${interior.id}`);
              if (!okInterior) continue;

              await page.waitForSelector(".single__slider", { timeout: 15000 });
              await new Promise((r) => setTimeout(r, 800));

              const accessories = await page.$$eval(
                ".form-check.form-check-1",
                (blocks) =>
                  blocks.map((block, i) => {
                    const input = block.querySelector(
                      'input[name="accessories[]"]'
                    );

                    const title =
                      block
                        .querySelector(".form-check-1__text")
                        ?.textContent.trim() ||
                      input?.value ||
                      "";

                    const price = input?.dataset.price || "0";

                    // ИЩЕМ КНОПКУ ХИНТА ВО ВСЁМ БЛОКЕ
                    const hintBtn =
                      block.querySelector("button[data-title]") ||
                      block.querySelector("button.single__hint") ||
                      block.querySelector("button.js__tooltip-1") ||
                      block.querySelector("button");

                    const hintTitle = hintBtn?.getAttribute("data-title") || "";
                    const hintText = hintBtn?.getAttribute("data-text") || "";

                    return {
                      index: i,
                      id: input?.id || "",
                      name: title,
                      price,
                      hintTitle,
                      hintText,
                    };
                  })
              );

              // ⚡ Доп. опции (charging)
              const charging = await page.$$eval(
                'input[name="charging[]"]',
                (inputs) =>
                  inputs.map((el, i) => {
                    const container = el.closest(".picture-select-def");
                    const titleEl = container?.querySelector(
                      ".picture-select-def__title"
                    );
                    const imgEl =
                      container?.querySelector("picture img") ||
                      container?.querySelector(
                        ".picture-select-def__body img"
                      ) ||
                      container?.querySelector("img");
                    const imgSrc =
                      imgEl?.getAttribute("data-src") ||
                      imgEl?.currentSrc ||
                      imgEl?.src ||
                      "";
                    const hintTitle = el.dataset.hintName || "";
                    const hintText = el.dataset.hint || "";
                    return {
                      index: i,
                      id: el.id,
                      name: titleEl?.textContent.trim() || el.value,
                      img: imgSrc,
                      price: el.dataset.price || "0",
                      hintTitle,
                      hintText,
                    };
                  })
              );

              comp.additional_options = charging;
              comp.carName = carName;
              comp.descriptionHTML = descriptionHTML;
              comp.accessories = accessories;

              // 📸 собираем галерею
              const gallery = await page.$$eval(".single__slider img", (imgs) =>
                imgs
                  .map((img) => img.getAttribute("src"))
                  .filter((src) => src && !src.includes("clone"))
                  .filter((src, i, arr) => arr.indexOf(src) === i)
                  .sort((a, b) => {
                    const nameA = a.split("/").pop().toLowerCase();
                    const nameB = b.split("/").pop().toLowerCase();
                    return nameA.localeCompare(nameB, "ru");
                  })
              );

              comp.items.push({
                bodyColorName: bodyColor.name,
                bodyColorCode: bodyColor.colorCode,
                bodyColorPrice: bodyColor.price,

                wheelName: wheel.name,
                wheelImage: wheel.img,
                wheelPrice: wheel.price,

                interiorColor: interior.name,
                interiorImage: interior.img,
                interiorPrice: interior.price,
              });

              console.log(
                `✅ ${comp.name}: ${bodyColor.name} + ${wheel.name} + ${interior.name} → ${gallery.length} фото, ${accessories.length} аксессуаров, ${additional_options.length} доп. опций`
              );
            }
          }
        }
      } catch (e) {
        console.warn("⚠️ Ошибка при комплектации", comp.value, e.message);
        comp.items = [];
      }
    }

    res.json({ success: true, compleetes });
  } catch (err) {
    console.error("❌ Ошибка парсинга:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    await browser.close();
  }
});

//app.listen(4000, () => console.log("✅ Puppeteer parser running on port 4000"));

https
  .createServer(
    {
      key: fs.readFileSync("/etc/ssl/private/ip.key"),
      cert: fs.readFileSync("/etc/ssl/certs/ip.crt"),
    },
    app
  )
  .listen(8500, () => {
    console.log("HTTPS on 8500");
  });
