// AI読み取り（Claude API）。使うときだけ読み込まれる。
// APIキーはこの端末の localStorage にだけ保存され、Anthropic のAPIにだけ送られる。
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@1.6.0';
import { betaJSONSchemaOutputFormat } from 'https://esm.sh/@anthropic-ai/sdk@1.6.0/helpers/beta/json-schema';

const MODEL = 'claude-opus-5-5';

export class AIError extends Error {}

function client(apiKey) {
  // 自分の端末で自分のキーを使う個人用アプリなので、ブラウザから直接呼び出す
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

const box = {
  type: 'object',
  description: '画像内の商品写真の位置。画像の左上を(0,0)、右下を(1000,1000)とした座標。商品写真が無ければ全て0。',
  properties: { x0: { type: 'integer' }, y0: { type: 'integer' }, x1: { type: 'integer' }, y1: { type: 'integer' } },
  required: ['x0', 'y0', 'x1', 'y1'],
  additionalProperties: false,
};

const itemProps = cats => ({
  name: { type: 'string', description: '商品名。ブランド名・色・サイズ・品番は含めず短く（例：エアリズムコットンオーバーサイズTシャツ）' },
  brand: { type: 'string', description: 'ブランド名。不明なら空文字' },
  category: { type: 'string', enum: cats },
  color: { type: 'string', description: '日本語のよくある色名（黒、白、グレー、ネイビー、ベージュ、ブラウン、カーキ、青、赤、緑など）。不明なら空文字' },
  size: { type: 'string', description: 'サイズ表記（M、L、26.5cm など）。不明なら空文字' },
});

async function call(apiKey, content, schema) {
  let res;
  try {
    res = await client(apiKey).beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaJSONSchemaOutputFormat(schema) },
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError('APIキーが正しくありません。「データ」タブで確認してください。');
    if (e instanceof Anthropic.PermissionDeniedError) throw new AIError('このAPIキーでは利用できません。');
    if (e instanceof Anthropic.RateLimitError) throw new AIError('混み合っています。少し待ってからもう一度お試しください。');
    if (e instanceof Anthropic.BadRequestError) throw new AIError('読み取りに失敗しました（' + e.message + '）');
    if (e instanceof Anthropic.APIConnectionError) throw new AIError('インターネットに接続できません。');
    if (e instanceof Anthropic.APIError) throw new AIError(`AIでエラーが発生しました（${e.status}）`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new AIError('この画像は読み取れませんでした。');
  if (res.stop_reason === 'max_tokens') throw new AIError('商品が多すぎて読み取りきれませんでした。画像を分けてお試しください。');
  if (!res.parsed_output) throw new AIError('読み取り結果を解釈できませんでした。');
  return res.parsed_output;
}

const img = dataUrl => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.split(',')[1] } });

// 購入履歴・注文確認メール・レシートのスクリーンショットから商品を抜き出す
export async function readPurchases(apiKey, dataUrl, cats, today) {
  const schema = {
    type: 'object',
    properties: {
      shop: { type: 'string', description: 'お店の名前（ユニクロ、GU、Amazon、楽天市場の店舗名など）' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ...itemProps(cats),
            price: { type: 'integer', description: '1点あたりの税込価格（円）。不明なら0' },
            quantity: { type: 'integer', description: '個数。不明なら1' },
            purchaseDate: { type: 'string', description: '注文日・購入日を YYYY-MM-DD で。不明なら空文字' },
            image_box: box,
          },
          required: ['name', 'brand', 'category', 'color', 'size', 'price', 'quantity', 'purchaseDate', 'image_box'],
          additionalProperties: false,
        },
      },
      skipped: { type: 'integer', description: '服・靴・バッグ・アクセサリー以外なので除外した商品の数' },
    },
    required: ['shop', 'items', 'skipped'],
    additionalProperties: false,
  };
  const prompt = `これはネットショップ（ユニクロ・GU・Amazon・楽天など）の購入履歴や注文確認メール、またはお店のレシートのスクリーンショットです。
クローゼット管理アプリに登録するため、写っている商品のうち、服・靴・バッグ・帽子・アクセサリーなど身につける物だけを抜き出してください。日用品・食品・本・家電などは除外し、その数を skipped に入れてください。
- 見切れていて商品名が読めないものは含めないでください。
- ユニクロ・GUの色表記「09 BLACK」のようなものは「黒」のように日本語の色名にしてください。
- 年が書かれていない日付は、今日（${today}）より未来にならない直近の年としてください。
- ブランドが書かれていなければ、ユニクロ・GUの商品はお店の名前をブランドにしてください。
- 商品の写真が写っていれば、その位置を image_box に入れてください。`;
  return call(apiKey, [img(dataUrl), { type: 'text', text: prompt }], schema);
}

// 服の写真1枚から、カテゴリ・色・名前などを推定する
export async function readPhoto(apiKey, dataUrl, cats) {
  const schema = {
    type: 'object',
    properties: itemProps(cats),
    required: ['name', 'brand', 'category', 'color', 'size'],
    additionalProperties: false,
  };
  const prompt = `クローゼット管理アプリに登録する持ち物の写真です。写っている主なアイテム1点について答えてください。
- name は「ボーダー長袖Tシャツ」「チェスターコート」のように、見た目が分かる短い名前にしてください。
- ブランドやサイズは、タグやロゴがはっきり読める場合だけ入れ、それ以外は空文字にしてください。`;
  return call(apiKey, [img(dataUrl), { type: 'text', text: prompt }], schema);
}

// APIキーの確認（ごく短い呼び出し）
export async function testKey(apiKey) {
  try {
    await client(apiKey).messages.create({ model: MODEL, max_tokens: 256, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'OKとだけ返して' }] });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError('APIキーが正しくありません。');
    if (e instanceof Anthropic.APIConnectionError) throw new AIError('インターネットに接続できません。');
    if (e instanceof Anthropic.APIError) throw new AIError(`エラーが発生しました（${e.status}）`);
    throw e;
  }
}
