/**
 * Copyright 2023 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/webrtc-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { ILog } from '../utils/ILog';
import { WebSocketReliable } from '../utils/WebSocketReliable';
import { IStats } from './IStats';
import { EventEmitter } from '../utils/EventEmitter';
import { Util } from '../utils/Util';

/**
 * Use Telemetry to report statistics from an {@link IStats} object
 * at a regular interval to a WebSocket or HTTP server.
 * @example
 * // Streamer statistics reporting to a websocket SSL server with a frequency of 1 second
 * const telemetry = new Telemetry('wss://address/metrics');
 * telemetry.report(new StreamerStats(streamer), 1);
 */
export class Telemetry extends EventEmitter implements ILog {
    /**
     * @override{@inheritDoc ILog.onLog}
     * @event
     */
    onLog(log: string) {}

    /**
     * @override{@inheritDoc ILog.onError}
     * @event
     */
    onError(error: string = 'unknown') {
        console.error(error);
    }

    /**
     * URL of connection
     */
    get url(): string {
        return this._url;
    }

    /**
     * Number of current reports
     */
    get reporting(): number {
        return this._reporting;
    }

    private _ws?: WebSocketReliable;
    private _fetch?: AbortController;
    private _url: string;
    private _reporting: number;

    /**
     * Build a metrics reporter configured with a URL, which can be a websocket or http server.
     * You must call {@link report} to start reporting metrics.
     *
     * @param url a Websocket or HTTP server URL.
     */
    constructor(url: string | URL) {
        super();
        url = new URL(url);
        if (url.protocol.startsWith('ws')) {
            this._ws = new WebSocketReliable();
        } else if (!url.protocol.startsWith('http')) {
            throw Error('Protocol ' + url.protocol + ' not supported');
        }
        this._url = url.toString();
        this._reporting = 0;
    }

    /**
     *  Starts reporting metrics from an {@link IStats} instance to the URL end-point
     * @param stats {@link IStats} implementation
     * @param frequency report interval, if is equals to 0 it reports only one time the stats
     */
    report(stats: IStats, frequency: number) {
        stats.onError = (error: string) => this.onError(stats.constructor.name + ' error, ' + error);
        stats.onLog = (log: string) => this.onError(stats.constructor.name + ', ' + log);

        let release: (() => void) | undefined = (stats.onRelease = () => {
            if (!release) {
                return;
            }
            release = undefined; // just one callback!
            clearInterval(interval);
            this.onLog('Stop ' + stats.constructor.name + ' reporting');
            if (--this._reporting > 0) {
                return;
            }
            // close useless connection!
            if (this._ws) {
                this._ws.close();
            }
            if (this._fetch) {
                this._fetch.abort();
            }
        });

        // start interval
        const interval = (frequency ? setInterval : setTimeout)(async () => {
            if (!frequency && release) {
                release();
            }
            try {
                await this._send(stats);
            } catch (e) {
                this.onError(stats.constructor.name + ' error, ' + Util.stringify(e));
            }
        }, frequency * 1000);

        ++this._reporting;

        this.onLog('Start ' + stats.constructor.name + ' reporting every ' + frequency + ' seconds');
    }

    private async _send(stats: IStats) {
        let data;
        try {
            data = await stats.serialize();
        } catch (e) {
            if (!e) {
                return;
            } // wait to be ready!
            throw e;
        }
        let body: string | ArrayBuffer;
        let mimeType;
        if (data instanceof ArrayBuffer) {
            mimeType = 'application/octet-stream';
            body = data;
        } else if (typeof data == 'string') {
            mimeType = 'text/plain';
            body = data;
        } else {
            mimeType = 'application/json';
            body = JSON.stringify(data);
        }

        if (this._ws) {
            // WEBSOCKET
            if (this._ws.closed) {
                // Open websocket when required!
                this._ws.open(this._url);
            }
            this._ws.queueing.length = 0; // erase the queueing stats if present!
            this._ws.send(body);
        } else {
            // HTTP
            if (this._fetch) {
                // abort previous stats sending
                this._fetch.abort();
            }
            this._fetch = new AbortController();
            fetch(this._url, {
                method: 'POST',
                body,
                headers: {
                    'Content-Type': mimeType
                },
                signal: this._fetch.signal
            });
        }
    }
}
