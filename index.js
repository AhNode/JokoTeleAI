require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");

const token = process.env.TELEGRAM_TOKEN;
const geminiKey = process.env.GEMINI_API_KEY;

if (!token || !geminiKey) {
	console.error("Error: Token atau API Key belum diset.");
	process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const genAI = new GoogleGenerativeAI(geminiKey);

// INSTRUKSI PERSONA JOKO
const systemInstruction = `
Kamu adalah asisten AI bernama *Joko*.
Persona:
- Gaya bicara lu kayak anak tongkrongan, kasar dikit gapapa, pake lo/gue.
- Lu konsisten pake bahasa gaul tapi tetep sopan kalau ngejelasin ilmu.
- Kalau ada yang curhat, posisikan diri lu sebagai temen yang asik, kasih saran singkat padat jelas (jangan ngasih opsi A/B/C kayak robot).
- Kalau user minta coding, kasih penjelasan yang gampang dimengerti.

ATURAN FORMATTING (PENTING):
1. Kode program WAJIB di dalam blok kode Markdown (\`\`\` ... \`\`\`).
2. Jangan pakai Header Markdown (tanda pagar #), ganti pakai Bold biasa aja.
3. Jangan pakai format LaTeX ($) untuk matematika.
`;

// Note: Menggunakan gemini-1.5-flash karena 2.5 belum stable release
const model = genAI.getGenerativeModel({
	model: "gemini-2.5-flash",
	systemInstruction: systemInstruction,
});

console.log("Bot Joko Siap Nongkrong ☕ (Formatter V2 Aktif)...");

bot.on("message", async (msg) => {
	const chatId = msg.chat.id;
	let userText = msg.caption || msg.text;

	// Logika Deteksi Gambar / Dokumen
	let photoFileId = null;
	if (msg.photo && msg.photo.length > 0) {
		photoFileId = msg.photo[msg.photo.length - 1].file_id;
	} else if (msg.document && msg.document.mime_type.startsWith("image/")) {
		photoFileId = msg.document.file_id;
	}

	if (!userText && !photoFileId) return;
	if (photoFileId && !userText) userText = "Woy Jok, jelasin ini gambar apaan?";

	// --- ANIMASI BERPIKIR (JOKO STYLE) ---
	let loadingMsgId = null;
	let animationInterval = null;

	try {
		const sentMsg = await bot.sendMessage(chatId, "Bentar, gua cek dulu... 🚬");
		loadingMsgId = sentMsg.message_id;

		let frame = 0;
		const frames = ["Mikir .", "Mikir ..", "Mikir ..."]; // Simpel aja biar gak kena limit
		animationInterval = setInterval(async () => {
			frame = (frame + 1) % frames.length;
			try {
				await bot.editMessageText(frames[frame], {
					chat_id: chatId,
					message_id: loadingMsgId,
				});
			} catch (e) {}
		}, 2000);

		// --- REQUEST GEMINI ---
		let result;
		if (photoFileId) {
			console.log(`[Visual] ${msg.from.first_name} kirim gambar`);
			const fileLink = await bot.getFileLink(photoFileId);
			const imageResponse = await axios.get(fileLink, {
				responseType: "arraybuffer",
			});
			const imagePart = {
				inlineData: {
					data: Buffer.from(imageResponse.data).toString("base64"),
					mimeType: "image/jpeg",
				},
			};
			result = await model.generateContent([userText, imagePart]);
		} else {
			console.log(`[Text] ${msg.from.first_name}: ${userText}`);
			result = await model.generateContent(userText);
		}

		const response = await result.response;
		const rawReply = response.text();

		// Matikan animasi
		clearInterval(animationInterval);
		await bot.deleteMessage(chatId, loadingMsgId);

		// --- KIRIM JAWABAN DENGAN FORMATTER BARU ---
		await sendFormattedMessage(chatId, rawReply);
	} catch (error) {
		if (animationInterval) clearInterval(animationInterval);
		if (loadingMsgId)
			try {
				await bot.deleteMessage(chatId, loadingMsgId);
			} catch (e) {}

		console.error("Error:", error.message);
		bot.sendMessage(
			chatId,
			"Duh sori bro, otak gua lagi nge-lag nih (Error Server). Coba tanya lagi tar."
		);
	}
});

// --- FUNGSI FORMATTER SPESIAL (MARKDOWN V2) ---
// Ini rahasianya biar codingan rapi tapi teks biasa gak error
async function sendFormattedMessage(chatId, text) {
	// 1. Sanitasi teks agar sesuai standar MarkdownV2 Telegram
	const formattedText = cleanMarkdownV2(text);
	const maxChars = 4000;

	const sendChunk = async (chunk) => {
		try {
			// Coba kirim pakai MarkdownV2
			await bot.sendMessage(chatId, chunk, { parse_mode: "MarkdownV2" });
		} catch (error) {
			console.log("Markdown V2 Error (Fallback ke plain text):", error.message);
			// Kalau masih error (jarang terjadi), kirim polos aja biar pesannya nyampe
			await bot.sendMessage(chatId, text);
		}
	};

	if (formattedText.length <= maxChars) {
		await sendChunk(formattedText);
	} else {
		for (let i = 0; i < formattedText.length; i += maxChars) {
			await sendChunk(formattedText.substring(i, i + maxChars));
		}
	}
}

// Fungsi Pembersih Karakter Khusus
function cleanMarkdownV2(text) {
	// Pecah pesan berdasarkan Code Block (```)
	// Kita gak mau ngubah-ngubah isi codingan
	const parts = text.split(/(```[\s\S]*?```)/g);

	return parts
		.map((part) => {
			// Kalau ini adalah blok kode, biarin aja
			if (part.startsWith("```")) {
				return part;
			}

			// Kalau ini teks biasa (penjelasan), kita harus escape karakter aneh
			// Karakter yang harus di-escape di Telegram V2: _ * [ ] ( ) ~ > # + - = | { } . !
			let escaped = part.replace(/([_*\[\]()~>#\+\-=|{}.!])/g, "\\$1"); // Tambah backslash di depan simbol

			// FIX BOLD: Gemini kasih **teks**, setelah di-escape jadi \*\*teks\*\*
			// Telegram maunya *teks*. Jadi kita ubah manual.
			escaped = escaped.replace(/\\\*\\\*(.*?)\\\*\\\*/g, "*$1*");

			return escaped;
		})
		.join("");
}
