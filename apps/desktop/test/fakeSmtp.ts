import { createServer, type Server } from 'node:net'

/** Minimal SMTP server for tests: records each delivered message (raw DATA). Auth optional. */
export function fakeSmtp(password = ''): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = []
  const server = createServer((sock) => {
    let data = false
    let buf = ''
    sock.write('220 fake.test ESMTP\r\n')
    sock.on('data', (chunk) => {
      buf += chunk.toString()
      if (data) {
        if (buf.includes('\r\n.\r\n')) {
          received.push(buf)
          buf = ''
          data = false
          sock.write('250 2.0.0 OK queued as FAKE123\r\n')
        }
        return
      }
      let idx
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const cmd = line.toUpperCase()
        if (cmd.startsWith('EHLO')) sock.write('250-fake.test\r\n250 AUTH PLAIN\r\n')
        else if (cmd.startsWith('AUTH PLAIN')) {
          const decoded = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString()
          sock.write(decoded.endsWith(`\u0000${password}`) ? '235 2.7.0 Authentication successful\r\n' : '535 5.7.8 Authentication credentials invalid\r\n')
        } else if (cmd.startsWith('MAIL FROM')) sock.write('250 OK\r\n')
        else if (cmd.startsWith('RCPT TO')) sock.write(cmd.includes('REJECT') ? '550 5.1.1 No such user\r\n' : '250 OK\r\n')
        else if (cmd === 'DATA') {
          data = true
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (cmd === 'QUIT') {
          sock.write('221 Bye\r\n')
          sock.end()
        } else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n')
        else sock.write('502 Command not implemented\r\n')
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, received })))
}
