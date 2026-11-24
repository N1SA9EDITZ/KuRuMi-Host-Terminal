const socket = io();

// টার্মিনাল কনফিগারেশন
const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 15,
    fontFamily: '"Courier New", Courier, monospace',
    fontWeight: 'bold',
    scrollback: 5000,        // === Scroll Fix: ৫০০০ লাইন পর্যন্ত স্ক্রল করা যাবে ===
    theme: {
        background: '#000000',
        foreground: '#00ff00', 
        cursor: '#FF5722',     
        selection: 'rgba(255, 87, 34, 0.3)'
    }
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));
fitAddon.fit();

// সার্ভার থেকে ডাটা আসলে দেখাবে
socket.on('output', (data) => {
    term.write(data);
});

// ইনপুট সার্ভারে পাঠানো
term.onData((data) => {
    socket.emit('input', data);
});

// উইন্ডো সাইজ পাল্টালে টার্মিনাল ঠিক থাকবে
window.addEventListener('resize', () => {
    fitAddon.fit();
    socket.emit('resize', { cols: term.cols, rows: term.rows });
});

// শুরুতে ফোকাস
setTimeout(() => {
    fitAddon.fit();
    socket.emit('resize', { cols: term.cols, rows: term.rows });
    term.focus();
    // কোনো ওয়েলকাম মেসেজ নেই, একদম ক্লিন টার্মিনাল
}, 200);
