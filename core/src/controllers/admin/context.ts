import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
export {};

/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */

export interface AdminSession {
    id?: string;
    username: string;
    role: string;
    accountLimit: number;
    subscription: any;
    card?: any;
    mustChangePassword?: boolean;
    createdAt: number;
}

export interface AdminContext {
    /**
     * 有效 token 集合。
     *
     * 上游 PR #181 改为 PersistentTokenSet（单管理员、凭据指纹绑定、落盘持久化），
     * 但本地是多用户体系：token 必须与 sessions 严格同步（登录时同时写入、
     * 退出时同时删除、鉴权时两者都要命中），clear() 也要按用户精确吊销。
     * 故保留 Set<string>，持久化 token 的能力在多用户下不适用。
     */
    tokens: Set<string>;
    /** token -> 登录用户会话（多用户体系） */
    sessions: Map<string, AdminSession>;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
}

function createAdminContext(dataProvider: any): AdminContext {
    const tokens = new Set<string>();
    const sessions = new Map<string, AdminSession>();
    return {
        tokens,
        sessions,
        app: null,
        server: null,
        io: null,
        provider: dataProvider,
    };
}

module.exports = { createAdminContext };
