import http from 'node:http';

// Tests bind random OS ports, which can be in fetch's browser-forbidden list.
// Native HTTP keeps the API assertions independent of that random allocation.
export function fetchLocal(input, {method = 'GET', headers = {}, body} = {}) {
    const url = new URL(input);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Synthetic loopback requests only');
    return new Promise((resolve, reject) => {
        const request = http.request(url, {method, headers}, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8'), received = new Headers();
                for (const [name, value] of Object.entries(response.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) received.append(name, item);
                resolve({status:response.statusCode,headers:received,json:async()=>JSON.parse(text),text:async()=>text});
            });
        });
        request.on('error', reject); request.end(body);
    });
}
