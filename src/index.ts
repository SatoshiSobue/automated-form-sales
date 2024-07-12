import { OpenAI } from "openai";
import { chromium } from "playwright";
import * as cheerio from "cheerio";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Replace with your OpenAI API key
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function fetchHTML(url: string): Promise<string> {
  const browser = await chromium.launch({ headless: false }); // ヘッドフルモードでブラウザを起動
  const page = await browser.newPage();
  await page.goto(url);
  const html = await page.content();
  await browser.close();
  return html;
}

async function extractFormHTML(html: string): Promise<string> {
  const $ = cheerio.load(html);
  const forms = $("form");
  let allFormsHTML = "";
  forms.each(function () {
    allFormsHTML += $(this).html() || ""; // 各formのHTMLを統合
  });
  return allFormsHTML;
}

async function analyzeFormWithChatGPT(formHTML: string): Promise<string> {
  const prompt = `
#指示
  次のHTMLを解析し、各フォーム要素のname属性とタイプを特定し、それを#サンプル　のようなJSON形式で返してください。

#ルール
  - keyがname属性のそのままとなるようにしてください
    例; name="area[data][]"⇨key="area[data][]"
  - tagがinputかつtypeがradio の場合は一つ目のoptionのvalue属性をvalueに入れてください。
  - tagがselectの場合はoptionのvalue属性が空文字でない中から3つ目の要素のvalueに入れてください。
  - tagがinputかつtypeがcheckboxの場合はvalueにtrueを入れてください。
  HTML: ${formHTML}

  #サンプル:
  {
    "name": {
        "tag": "input",
        "type": "text"
    },
    "email": {
        "tag": "input",
        "type": "email"
    },
    "body": {
        "tag": "textarea",
        "type": "text"
    },
    "agree": {
        "tag": "input",
        "type": "checkbox",
        "value": "true"
    },
    "reason": {
        "tag": "input",
        "type": "radio",
        "value": "youtube"

    },
    "type": {
        "tag": "select",
        "value": "1"
    }
  }
  `;
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens: 2000,
  });
  const result = response.choices[0].message.content ?? "";
  try {
    JSON.parse(result);
    return result;
  } catch (error) {
    console.error("Received invalid JSON:", result);
    throw new Error("Invalid JSON received from GPT-3");
  }
}

async function normalizeFields(
  fields: Record<string, { tag: string; type: string; value?: string }>,
): Promise<Record<string, { tag: string; type: string; value?: string }>> {
  const prompt = `
  #指示
  次の#データ から、formデータを生成してください
  結果を#出力サンプル のようなJSON形式で返してください。
  
  #フォームフィールド: ${JSON.stringify(fields)}

#ルール
  以下のステップで順に整形してください
  - #typeがhiddenの場合はフォームフィールドから除外してください
  - #データに含まれないフィールドはフォームフィールドから除外してください
  - #データが持つkeyをそのまま#フォームフィールドのkeyとして使ってください
  - #フォームフィールドのtagは#データのtagと一致させてください
  - #データにvalueが元々定義されている場合はその値を必ずvalueに入れてください。
  - valueの定義がされていない場合はkey名から適当に推察し、それらしいデータを入れてください

  #出力サンプル:
  {
    company: { tag: 'input', type: 'text', value: 'Example Inc.' },
    name: { tag: 'input', type: 'text', value: 'John Doe' },
    email: { tag: 'input', type: 'email', value: 'john.doe@example.com' },
    tel: { tag: 'input', type: 'tel', value: '123-456-7890' },
    budget_radio: { tag: 'input', type: 'radio', value: '総額' },
    budget: { tag: 'input', type: 'select', value: '2,500万円以上' },
    'area[data][]': { tag: 'input', type: 'checkbox', value: 'true' },
    partner: { tag: 'input', type: 'select', value: '指定なし' },
    textarea: {
      tag: 'textarea',
      type: 'text',
      value: 'This is a test message. I would like to inquire about your services.'
    },
    'agree[data][]': { tag: 'input', type: 'checkbox', value: 'true' }
  }
  `;
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens: 500,
  });
  return JSON.parse(response.choices[0].message.content ?? "");
}

async function fillFormAndSubmit(
  url: string,
  formData: Record<string, { tag: string; type: string; value?: string }>,
): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(url);

  for (const [field, details] of Object.entries(formData)) {
    const selector = `${details.tag}[name="${field}"]`;
    const value = formData[field].value || getDefaultFieldValue(details.type);
    console.log(selector);
    console.log(value);
    if (details.type === "checkbox") {
      const checkboxes = await page.$$(selector);
      if (checkboxes.length > 0) {
        try {
          await checkboxes[0].setChecked(true, { force: true });
        } catch (error) {
          console.error(
            `チェックボックスの操作中にエラーが発生しました: ${error}`,
          );
          // id属性を持つinputと紐づいているlabelを探してクリック
          const inputId = await checkboxes[0].getAttribute("id");
          if (inputId) {
            const labelForInput = await page.$(`label[for="${inputId}"]`);
            if (labelForInput) {
              await labelForInput.click();
            } else {
              console.error(`id属性に紐づくラベルが見つかりません: ${inputId}`);
            }
          }
          // 直上のlabel要素を探してクリック
          const parentLabel = await checkboxes[0].evaluateHandle((el) =>
            el.closest("label"),
          );
          if (parentLabel && (await parentLabel.asElement())) {
            // ブラウザのコンテキストでクリックを実行
            await page.evaluate((label) => {
              if (label) label.click();
            }, parentLabel);
          } else {
            console.error(`直上のラベルが見つかりません: ${field}`);
          }
        }
      } else {
        // name属性が指定されていないチェックボックスを探してチェック
        const unnamedCheckbox = await page.$(
          'input[type="checkbox"]:not([name])',
        );
        if (unnamedCheckbox) {
          await unnamedCheckbox.setChecked(true, { force: true });
        } else {
          console.error(
            `チェックボックスが見つかりません: セレクター = ${selector}`,
          );
        }
      }
    } else if (details.type === "radio") {
      await page.check(`${selector}[value="${value}"]`);
    } else if (details.tag === "select") {
      await page.selectOption(selector, { value: value }); // selectタグの場合はselectOptionを使用
    } else {
      await page.fill(selector, value);
    }
  }

  await page.waitForTimeout(30000); // 結果を確認するために待機
  await browser.close();
}

function getDefaultFieldValue(type: string): string {
  switch (type) {
    case "input":
    case "textarea":
      return "default text";
    case "select":
      return "1"; // 通常は最初のオプションの値を想定
    default:
      return "";
  }
}

async function automateContactForm(url: string): Promise<void> {
  try {
    // Fetch and parse HTML
    const html = await fetchHTML(url);
    const formHTML = await extractFormHTML(html);

    // Analyze form HTML with ChatGPT to get required fields
    const requiredFieldsJson = await analyzeFormWithChatGPT(formHTML);
    const requiredFields = JSON.parse(requiredFieldsJson);
    console.log(requiredFields);

    // Normalize form data
    const normalizedData = await normalizeFields(requiredFields);
    console.log(normalizedData);

    // Fill and submit the form
    await fillFormAndSubmit(url, normalizedData);
  } catch (error) {
    console.error("Error:", error);
  }
}

const url = "https://mh-sp.com/contact/";

automateContactForm(url);
