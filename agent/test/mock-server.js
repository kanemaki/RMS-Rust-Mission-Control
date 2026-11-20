// Servidor falso para testar o ciclo de vida sem o RustDedicated real.
console.log('Mock Rust server starting...');
console.log('Server startup complete');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
