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

// --- KONFIGURASI ---
const bot = new TelegramBot(token, {
	polling: true,
	// ⚠️ PENTING: Uncomment baris di bawah ini HANYA JIKA menggunakan VPS + Docker
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

// Menggunakan 1.5-flash yang stabil & cepat untuk edit message
const model = genAI.getGenerativeModel({
	model: "gemini-2.5-pro",
	systemInstruction: systemInstruction,
});

console.log("====================================================");
console.log("🚀 BOT JOKO SIAP (SEAMLESS EDIT MODE)");
console.log("👉 Pesan 'Loading' akan berubah langsung jadi Jawaban");
console.log("====================================================");

bot.on("message", async (msg) => {
	const chatId = msg.chat.id;
	let userText = msg.caption || msg.text;

	// Log sederhana
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
	if (fileId && !userText)
		userText = "Analisis file media ini sesuai instruksi persona kamu.";

	// --- SETUP ANIMASI ---
	let loadingMsgId = null;
	let animationInterval = null;

	try {
		// 1. Kirim Pesan Loading Awal
		const sentMsg = await bot.sendMessage(chatId, "Bentar...", {
			parse_mode: "Markdown",
		});
		loadingMsgId = sentMsg.message_id;

		// 2. Jalankan Animasi Edit (Spinner)
		// Animasi ini akan mengedit pesan yang sama berulang-ulang
		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		let frameIndex = 0;

		animationInterval = setInterval(async () => {
			frameIndex = (frameIndex + 1) % frames.length;
			try {
				await bot.editMessageText(`${frames[frameIndex]} Lagi mikir...`, {
					chat_id: chatId,
					message_id: loadingMsgId,
					parse_mode: "Markdown",
				});
			} catch (e) {
				// Error sering terjadi jika edit terlalu cepat, abaikan saja agar tidak crash
			}
		}, 400); // Jeda 1.5 detik (Aman dari limit Telegram)

		// --- REQUEST GEMINI ---
		let result;
		if (fileId) {
			console.log(`⬇️  Mendownload File...`);
			const fileLink = await bot.getFileLink(fileId);

			// Logika Retry Download (Wajib untuk Local Server)
			let mediaResponse = null;
			let attempts = 0;
			while (attempts < 5) {
				try {
					mediaResponse = await axios.get(fileLink, {
						responseType: "arraybuffer",
					});
					break;
				} catch (err) {
					if (err.response && err.response.status === 404) {
						attempts++;
						await new Promise((r) => setTimeout(r, 1500));
					} else {
						throw err;
					}
				}
			}

			if (!mediaResponse) throw new Error("Gagal download file (Timeout).");

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

		// --- STEP PENTING: TRANSISI MULUS ---
		// Matikan animasi dulu
		clearInterval(animationInterval);

		// Panggil fungsi edit canggih (Bukan delete)
		await sendSeamlessReply(chatId, loadingMsgId, rawReply);
	} catch (error) {
		if (animationInterval) clearInterval(animationInterval);
		console.error("❌ ERROR:", error.message);

		// Jika error, Ubah pesan loading menjadi pesan error
		if (loadingMsgId) {
			try {
				await bot.editMessageText("❌ _Duh error bro: " + error.message + "_", {
					chat_id: chatId,
					message_id: loadingMsgId,
					parse_mode: "Markdown",
				});
			} catch (e) {}
		}
	}
});

// --- FUNGSI REPLY CANGGIH (EDIT MODE) ---
async function sendSeamlessReply(chatId, messageIdToEdit, text) {
	const formattedText = cleanMarkdownV2(text);
	const maxChars = 4000; // Batas aman Telegram

	// SKENARIO 1: Pesan Pendek (Langsung Edit)
	if (formattedText.length <= maxChars) {
		try {
			// Kita EDIT pesan "Loading..." menjadi Jawaban
			await bot.editMessageText(formattedText, {
				chat_id: chatId,
				message_id: messageIdToEdit,
				parse_mode: "MarkdownV2",
			});
		} catch (error) {
			// Fallback jika MarkdownV2 gagal, kirim text biasa (masih edit)
			await bot.editMessageText(text, {
				chat_id: chatId,
				message_id: messageIdToEdit,
			});
		}
	}
	// SKENARIO 2: Pesan Panjang (Terpaksa Delete & Kirim Ulang)
	// Karena Telegram tidak bisa mengedit pesan menjadi 2 bagian terpisah
	else {
		try {
			await bot.deleteMessage(chatId, messageIdToEdit);
		} catch (e) {}

		// Kirim berantai (Chunking)
		for (let i = 0; i < formattedText.length; i += maxChars) {
			const chunk = formattedText.substring(i, i + maxChars);
			try {
				await bot.sendMessage(chatId, chunk, { parse_mode: "MarkdownV2" });
			} catch (error) {
				await bot.sendMessage(chatId, chunk);
			}
		}
	}
}

// Pembersih Markdown V2
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
