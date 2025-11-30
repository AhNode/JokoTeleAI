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
	// baseApiUrl: "http://localhost:8081", // Uncomment jika pakai Local Server
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

// Menggunakan model 1.5-flash/pro
const model = genAI.getGenerativeModel({
	model: "gemini-2.5-pro", // Atau gemini-1.5-flash
	systemInstruction: systemInstruction,
});

// --- VARIABEL SESSION & RUNTIME ---
const activeSessions = new Map(); // Tempat simpan ingatan: chatId -> chatSession
const startTime = Date.now(); // Waktu mulai bot

// Fungsi hitung runtime
function getUptime() {
	const now = Date.now();
	const diff = now - startTime;

	const seconds = Math.floor((diff / 1000) % 60);
	const minutes = Math.floor((diff / (1000 * 60)) % 60);
	const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
	const days = Math.floor(diff / (1000 * 60 * 60 * 24));

	let uptimeStr = "";
	if (days > 0) uptimeStr += `${days} hari, `;
	if (hours > 0) uptimeStr += `${hours} jam, `;
	if (minutes > 0) uptimeStr += `${minutes} menit, `;
	uptimeStr += `${seconds} detik.`;

	return uptimeStr;
}

console.log("====================================================");
console.log("🚀 BOT JOKO SIAP (MEMORY + RUNTIME MODE)");
console.log("👉 /new untuk reset ingatan");
console.log("👉 /runtime untuk cek durasi on");
console.log("====================================================");

bot.on("message", async (msg) => {
	const chatId = msg.chat.id;
	let userText = msg.caption || msg.text || "";

	// Log sederhana
	console.log(
		`\n📩 Pesan dari: ${msg.from.first_name} (${chatId}) \n📩 ${msg.text}\n`
	);

	// --- 0. CEK COMMANDS (/new & /runtime) ---
	if (userText.toLowerCase() === "/new") {
		activeSessions.delete(chatId); // Hapus sesi
		await bot.sendMessage(
			chatId,
			"*Ingatan udah gue reset bro.* Kita mulai dari nol ya!",
			{ parse_mode: "Markdown" }
		);
		return;
	}

	if (userText.toLowerCase() === "/runtime") {
		const uptime = getUptime();
		await bot.sendMessage(
			chatId,
			`⏱️ *Runtime Joko:*\nBot udah nyala selama: ${uptime}`,
			{ parse_mode: "Markdown" }
		);
		return;
	}

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

	// Jika cuma teks kosong dan gak ada file, skip (kecuali command di atas sudah handle)
	if (!userText && !fileId) return;

	// Default text jika kirim file doang
	if (fileId && !userText) userText = "Analisis file ini bro.";

	// --- SETUP ANIMASI ---
	let loadingMsgId = null;
	let animationInterval = null;

	try {
		// 1. Kirim Pesan Loading
		const sentMsg = await bot.sendMessage(chatId, "Bentar...", {
			parse_mode: "Markdown",
		});
		loadingMsgId = sentMsg.message_id;

		// 2. Animasi Spinner
		const frames = ["", ".", "..", "...", "..", "."];
		let frameIndex = 0;
		animationInterval = setInterval(async () => {
			frameIndex = (frameIndex + 1) % frames.length;
			try {
				await bot.editMessageText(`Lagi mikir${frames[frameIndex]}`, {
					chat_id: chatId,
					message_id: loadingMsgId,
					parse_mode: "Markdown",
				});
			} catch (e) {}
		}, 750); // Agak dilambatin biar gak kena limit Telegram

		// --- MANAJEMEN SESSION (MEMORY) ---
		// Cek apakah user ini udah punya sesi?
		let chatSession = activeSessions.get(chatId);

		if (!chatSession) {
			// Kalau belum, buat sesi baru
			chatSession = model.startChat({
				history: [], // Mulai dengan history kosong (System instruction udah di-inject di model)
			});
			activeSessions.set(chatId, chatSession);
			console.log(`🧠 Sesi baru dibuat untuk ${chatId}`);
		}

		// --- REQUEST GEMINI ---
		let result;

		if (fileId) {
			console.log(`⬇️  Mendownload File...`);
			const fileLink = await bot.getFileLink(fileId);

			// Retry logic download
			let mediaResponse = null;
			let attempts = 0;
			while (attempts < 5) {
				try {
					mediaResponse = await axios.get(fileLink, {
						responseType: "arraybuffer",
					});
					break;
				} catch (err) {
					attempts++;
					await new Promise((r) => setTimeout(r, 1000));
				}
			}
			if (!mediaResponse) throw new Error("Gagal download file.");

			const mediaPart = {
				inlineData: {
					data: Buffer.from(mediaResponse.data).toString("base64"),
					mimeType: mimeType,
				},
			};
			console.log(`📤 Mengirim ke Gemini (dengan Memory)...`);

			// PENTING: Kirim array [text, media] ke sendMessage session
			result = await chatSession.sendMessage([userText, mediaPart]);
		} else {
			console.log(`📤 Mengirim Teks ke Gemini (dengan Memory)...`);
			// PENTING: Pakai chatSession.sendMessage bukan model.generateContent
			result = await chatSession.sendMessage(userText);
		}

		const response = await result.response;
		const rawReply = response.text();
		console.log(`✅ Gemini Membalas.`);

		clearInterval(animationInterval);
		await sendSeamlessReply(chatId, loadingMsgId, rawReply);
	} catch (error) {
		if (animationInterval) clearInterval(animationInterval);
		console.error("❌ ERROR:", error.message);

		// Jika errornya karena Safety/Blocked
		let errorMsg = "❌ _Duh error bro: " + error.message + "_";
		if (error.message.includes("SAFETY")) {
			errorMsg =
				"❌ _Waduh, bahasan lo terlalu bahaya bro, gue gak berani jawab._";
		}

		if (loadingMsgId) {
			try {
				await bot.editMessageText(errorMsg, {
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
	const maxChars = 4000;

	if (formattedText.length <= maxChars) {
		try {
			await bot.editMessageText(formattedText, {
				chat_id: chatId,
				message_id: messageIdToEdit,
				parse_mode: "MarkdownV2",
			});
		} catch (error) {
			await bot.editMessageText(text, {
				chat_id: chatId,
				message_id: messageIdToEdit,
			});
		}
	} else {
		try {
			await bot.deleteMessage(chatId, messageIdToEdit);
		} catch (e) {}

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
