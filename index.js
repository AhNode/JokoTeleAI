require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");

const token = process.env.TELEGRAM_TOKEN;
const geminiKey = process.env.GEMINI_API_KEY;

if (!token || !geminiKey) {
	console.error("❌ Error: Token atau API Key belum diset.");
	process.exit(1);
}

// --- KONFIGURASI STANDARD (LAPTOP) ---
// Hapus 'baseApiUrl' agar konek ke server resmi Telegram
const bot = new TelegramBot(token, {
	polling: true,
	baseApiUrl: "http://localhost:8081", // <--- TAMBAHKAN INI!
});

const genAI = new GoogleGenerativeAI(geminiKey);

const systemInstruction = `
Kamu adalah asisten AI bernama *Joko*.
Persona:
- Gaya bicara lu kayak anak tongkrongan, kasar dikit gapapa, pake lo/gue.
- Kalau user kirim AUDIO/LAGU: Tebak judul lagu dan penyanyinya.
- Kalau user kirim VN/OMONGAN: Dengerin dan jawab maksudnya.
- Kalau user kirim VIDEO: Jelasin apa yang terjadi di video itu.
`;

const model = genAI.getGenerativeModel({
	model: "gemini-2.5-pro",
	systemInstruction: systemInstruction,
});

console.log("====================================================");
console.log("💻 BOT JOKO SIAP (MODE LAPTOP / STANDARD)");
console.log("👉 Support: Text, Foto, Audio, VN, Video (Max 20MB)");
console.log("====================================================");

bot.on("message", async (msg) => {
	const chatId = msg.chat.id;
	let userText = msg.caption || msg.text;

	console.log(`\n📩 Pesan dari: ${msg.from.first_name}`);

	// --- 1. DETEKSI TIPE FILE ---
	let fileId = null;
	let mimeType = "";
	let fileType = "TEXT";

	if (msg.photo) {
		fileId = msg.photo[msg.photo.length - 1].file_id;
		mimeType = "image/jpeg";
		fileType = "FOTO";
	} else if (msg.voice) {
		fileId = msg.voice.file_id;
		mimeType = "audio/ogg";
		fileType = "VOICE NOTE";
	} else if (msg.audio) {
		fileId = msg.audio.file_id;
		mimeType = msg.audio.mime_type || "audio/mpeg";
		fileType = "AUDIO MP3";
	} else if (msg.video) {
		fileId = msg.video.file_id;
		mimeType = msg.video.mime_type || "video/mp4";
		fileType = "VIDEO";
	} else if (msg.document) {
		const mime = msg.document.mime_type;
		if (
			mime &&
			(mime.startsWith("image/") ||
				mime.startsWith("audio/") ||
				mime.startsWith("video/"))
		) {
			fileId = msg.document.file_id;
			mimeType = mime;
			fileType = "DOKUMEN MEDIA";
		}
	}

	console.log(`🔍 Tipe Konten: ${fileType}`);

	if (!userText && !fileId) return;

	// Default prompt
	if (fileId && !userText) {
		userText = "Analisis file media ini sesuai instruksi persona kamu.";
	}

	// --- ANIMASI BERPIKIR ---
	let loadingMsgId = null;
	let animationInterval = null;

	try {
		const sentMsg = await bot.sendMessage(chatId, "Bentar, gua cek dulu... ");
		loadingMsgId = sentMsg.message_id;

		let frame = 0;
		const frames = ["", ".", ".."];
		animationInterval = setInterval(async () => {
			frame = (frame + 1) % frames.length;
			try {
				await bot.editMessageText(`Lagi mikir ${frames[frame]}`, {
					chat_id: chatId,
					message_id: loadingMsgId,
				});
			} catch (e) {}
		}, 2000);

		// --- REQUEST GEMINI ---
		let result;
		if (fileId) {
			console.log(`⬇️  Mendownload File dari Telegram Server...`);

			// 1. Minta Link (Akan dapat link https://api.telegram.org/...)
			const fileLink = await bot.getFileLink(fileId);

			// 2. Download Buffer
			const mediaResponse = await axios.get(fileLink, {
				responseType: "arraybuffer",
			});
			const bufferData = Buffer.from(mediaResponse.data);

			console.log(
				`✅ Download Selesai! Ukuran: ${(bufferData.length / 1024).toFixed(
					2
				)} KB`
			);

			const mediaPart = {
				inlineData: {
					data: bufferData.toString("base64"),
					mimeType: mimeType,
				},
			};

			console.log(`📤 Mengirim ke Gemini...`);
			result = await model.generateContent([userText, mediaPart]);
		} else {
			console.log(`📤 Mengirim Teks ke Gemini...`);
			result = await model.generateContent(userText);
		}

		const response = await result.response;
		const rawReply = response.text();
		console.log(`✅ Gemini Membalas Selesai.`);

		clearInterval(animationInterval);
		await bot.deleteMessage(chatId, loadingMsgId);

		await sendFormattedMessage(chatId, rawReply);
	} catch (error) {
		if (animationInterval) clearInterval(animationInterval);
		if (loadingMsgId)
			try {
				await bot.deleteMessage(chatId, loadingMsgId);
			} catch (e) {}

		console.error("❌ ERROR:", error.message);

		let errorMsg = "Duh error bro.";
		if (error.message.includes("file is too big")) {
			errorMsg = "Waduh, filenya kegedean bro! Di laptop limitnya cuma 20MB.";
		}
		bot.sendMessage(chatId, errorMsg);
	}
});

// --- FORMATTER ---
async function sendFormattedMessage(chatId, text) {
	const formattedText = cleanMarkdownV2(text);
	const maxChars = 4000;
	const sendChunk = async (chunk) => {
		try {
			await bot.sendMessage(chatId, chunk, { parse_mode: "MarkdownV2" });
		} catch (error) {
			console.log("⚠️ Markdown Error, kirim polos.");
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

function cleanMarkdownV2(text) {
	const parts = text.split(/(```[\s\S]*?```)/g);
	return parts
		.map((part) => {
			if (part.startsWith("```")) return part;
			let escaped = part.replace(/([_*\[\]()~>#\+\-=|{}.!])/g, "\\$1");
			escaped = escaped.replace(/\\\*\\\*(.*?)\\\*\\\*/g, "*$1*");
			return escaped;
		})
		.join("");
}
