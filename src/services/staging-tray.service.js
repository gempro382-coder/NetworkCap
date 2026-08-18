'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

class StagingTrayService extends EventEmitter {
  constructor() {
    super();
    this.images = [];
  }

  get count() {
    return this.images.length;
  }

  get totalBytes() {
    return this.images.reduce((sum, image) => sum + image.bytes, 0);
  }

  isEmpty() {
    return this.count === 0;
  }

  add(input, meta = {}) {
    const source = Buffer.isBuffer(input) ? { buffer: input } : input || {};
    const buffer = Buffer.isBuffer(source.buffer)
      ? Buffer.from(source.buffer)
      : source.buffer
        ? Buffer.from(source.buffer)
        : null;
    if (!buffer || !buffer.length) throw new Error('Cannot stage an empty image.');
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 18 MB staging limit.');
    if (this.count >= MAX_IMAGES) throw new Error(`The staging tray supports up to ${MAX_IMAGES} images.`);
    if (this.totalBytes + buffer.length > MAX_TOTAL_BYTES) throw new Error('Staged images exceed the 60 MB total limit.');

    const thumbSource = meta.thumbnail || source.thumbnail || null;
    const thumbnailBuffer = thumbSource?.buffer
      ? (Buffer.isBuffer(thumbSource.buffer) ? Buffer.from(thumbSource.buffer) : Buffer.from(thumbSource.buffer))
      : null;
    const item = {
      id: crypto.randomUUID(),
      buffer,
      bytes: buffer.length,
      mimeType: source.mimeType || meta.mimeType || 'image/png',
      thumbnailBuffer,
      thumbnailMimeType: thumbSource?.mimeType || 'image/jpeg',
      label: meta.label || source.label || `Image ${this.count + 1}`,
      createdAt: Date.now()
    };
    this.images.push(item);
    this._changed();
    return { ...item, buffer: undefined, thumbnailBuffer: undefined };
  }

  remove(id) {
    const index = this.images.findIndex((image) => image.id === id);
    if (index < 0) return false;
    this.images.splice(index, 1);
    this._changed();
    return true;
  }

  clear() {
    const count = this.count;
    this.images = [];
    if (count) this._changed();
    return count;
  }

  removeLast() {
    if (!this.images.length) return null;
    const item = this.images.pop();
    this._changed();
    return { id: item.id, label: item.label, bytes: item.bytes };
  }

  toGeminiPayload() {
    return this.images.map(({ buffer, mimeType }) => ({ buffer: Buffer.from(buffer), mimeType }));
  }

  toRendererState() {
    return {
      count: this.count,
      totalBytes: this.totalBytes,
      images: this.images.map((image) => {
        const preview = image.thumbnailBuffer || image.buffer;
        const previewType = image.thumbnailBuffer ? image.thumbnailMimeType : image.mimeType;
        return {
          id: image.id,
          label: image.label,
          bytes: image.bytes,
          mimeType: image.mimeType,
          createdAt: image.createdAt,
          thumbnail: `data:${previewType};base64,${preview.toString('base64')}`
        };
      })
    };
  }

  _changed() {
    this.emit('changed', this.toRendererState());
  }
}

const stagingTray = new StagingTrayService();
module.exports = { StagingTrayService, stagingTray, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES };
