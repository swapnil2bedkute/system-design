import mongoose from 'mongoose';

const usernameSchema = new mongoose.Schema(
  { username: { type: String, required: true, unique: true, lowercase: true, trim: true } },
  { versionKey: false },
);

export const Username = mongoose.model('Username', usernameSchema, 'usernames');
