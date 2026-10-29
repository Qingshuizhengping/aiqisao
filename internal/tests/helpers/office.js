function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// Minimal stored ZIPs keep parser fixtures independent from the implementation's archive library.
export function zip(entries) {
    const files = [];
    const directory = [];
    let offset = 0;
    for (const [name, content] of Object.entries(entries)) {
        const filename = Buffer.from(name);
        const bytes = Buffer.from(content);
        const checksum = crc32(bytes);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
        local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
        files.push(local, filename, bytes);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt32LE(checksum, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
        directory.push(central, filename);
        offset += local.length + filename.length + bytes.length;
    }
    const central = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
    end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...files, central, end]);
}


export function sparseWorkbookFixture() {
    return zip({ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="inlineStr"><is><t>门店</t></is></c><c r="B1" t="inlineStr"><is><t>已付款</t></is></c><c r="C1" t="inlineStr"><is><t>待付款</t></is></c></row>'
        + '<row r="2"><c r="A2" t="inlineStr"><is><t>青禾店</t></is></c><c r="C2"><v>25000</v></c></row>'
        + '</sheetData></worksheet>' });
}
