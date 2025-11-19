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

// --- KONFIGURASI VPS (DENGAN DOCKER LOKAL) ---
const bot = new TelegramBot(token, {
	polling: true,
	// Wajib arahkan ke Docker Local Server biar limit 2GB & support file besar
	// baseApiUrl: "http://localhost:8081",
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

// Gunakan 1.5-flash (Cepat & Support Audio/Video)
// Jangan pakai 2.5-pro dulu karena belum stabil
const model = genAI.getGenerativeModel({
	model: "gemini-2.5-flash",
	systemInstruction: systemInstruction,
});

console.log("====================================================");
console.log("🚀 BOT JOKO SIAP (MODE VPS + LOCAL DOCKER)");
console.log("👉 Support: Text, Foto, Audio, VN, Video (Max 2GB)");
console.log("====================================================");

bot.on("message", async (msg) => {
	const chatId = msg.chat.id;
	let userText = msg.caption || msg.text;

	// Log sederhana biar terminal gak penuh
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

	if (fileType !== "TEXT") console.log(`🔍 Tipe Konten: ${fileType}`);

	if (!userText && !fileId) return;

	if (fileId && !userText) {
		userText = "Analisis file media ini sesuai instruksi persona kamu.";
	}

	// --- ANIMASI BERPIKIR ---
	let loadingMsgId = null;
	let animationInterval = null;

	try {
		const sentMsg = await bot.sendMessage(chatId, "Bentar, gua cek dulu... 🎧");
		loadingMsgId = sentMsg.message_id;

		let frame = 0;
		const frames = ["⏳", "⏳.", "⏳.."];
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
			console.log(`⬇️  Mendownload File dari Local Server...`);

			// 1. Minta Link (Dapat Link Localhost)
			const fileLink = await bot.getFileLink(fileId);
			console.log(`🔗 Link: ${fileLink}`);

			// 2. LOGIKA RETRY (PENTING UNTUK LOCAL SERVER)
			// Kita coba download 5 kali. Kalau 404, tunggu 1 detik lalu coba lagi.
			let mediaResponse = null;
			let attempts = 0;
			const maxAttempts = 5;

			while (attempts < maxAttempts) {
				try {
					mediaResponse = await axios.get(fileLink, {
						responseType: "arraybuffer",
					});
					break; // Sukses! Keluar loop
				} catch (err) {
					if (err.response && err.response.status === 404) {
						attempts++;
						console.log(
							`⏳ Server belum siap (404). Tunggu bentar... (${attempts}/${maxAttempts})`
						);
						await new Promise((r) => setTimeout(r, 1500)); // Tunggu 1.5 detik
					} else {
						throw err; // Error lain lempar aja
					}
				}
			}

			if (!mediaResponse)
				throw new Error("Gagal download file (Timeout Local Server).");

			console.log(
				`✅ Download OK! Size: ${(mediaResponse.data.length / 1024).toFixed(
					2
				)} KB`
			);

			const mediaPart = {
				inlineData: {
					data: Buffer.from(mediaResponse.data).toString("base64"),
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
		console.log(`✅ Gemini Membalas.`);

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
		if (error.message.includes("ECONNREFUSED")) {
			errorMsg = "Waduh, Docker Local Server mati nih. Cek VPS lu!";
		}
		bot.sendMessage(chatId, errorMsg);
	}
});

// --- FORMATTER MARKDOWN V2 ---
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
