import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const TOKEN_EXPIRY = '8h';

export function generateToken(user, { mustChangePassword = false } = {}) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error("JWT_SECRET is not configured.");
    }
    return jwt.sign(
        {
        userId: user.id,
        number: user.phoneNumber,
        role: user.role,
        mustChangePassword,
    }, secret, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error("JWT_SECRET is not configured.");
    }
    try {
        return jwt.verify(token, secret);
    } catch (error) {
        throw new Error('Invalid or expired authentication token payload.');
    }
}

export async function hashPassword(password) {
    return bcrypt.hash(password, 10);
}

export async function comparePasswords(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
}