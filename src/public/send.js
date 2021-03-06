/* @flow */

import { ZalgoPromise } from 'zalgo-promise/src';
import { isAncestor, isWindowClosed, getDomain, matchDomain, type CrossDomainWindowType, type DomainMatcher } from 'cross-domain-utils/src';
import { uniqueID, isRegex, noop, safeInterval, stringify, stringifyError } from 'belter/src';


import { CHILD_WINDOW_TIMEOUT, MESSAGE_TYPE, WILDCARD, MESSAGE_NAME, ACK_TIMEOUT, RES_TIMEOUT, ACK_TIMEOUT_KNOWN, RESPONSE_CYCLE_TIME } from '../conf';
import { sendMessage, addResponseListener, deleteResponseListener, markResponseListenerErrored, type ResponseListenerType } from '../drivers';
import { awaitWindowHello, sayHello, isWindowKnown } from '../lib';
import { windowStore } from '../global';
import type { SendType } from '../types';

import { on } from './on';

function validateOptions(name : string, win : CrossDomainWindowType, domain : ?DomainMatcher) {
    if (!name) {
        throw new Error('Expected name');
    }

    if (domain) {
        if (typeof domain !== 'string' && !Array.isArray(domain) && !isRegex(domain)) {
            throw new TypeError(`Expected domain to be a string, array, or regex`);
        }
    }

    if (isWindowClosed(win)) {
        throw new Error('Target window is closed');
    }
}

function normalizeDomain(win : CrossDomainWindowType, targetDomain : DomainMatcher, actualDomain : ?string, { send } : {| send : SendType |}) : ZalgoPromise<string | $ReadOnlyArray<string>> {
    if (typeof targetDomain === 'string') {
        return ZalgoPromise.resolve(targetDomain);
    }
    
    return ZalgoPromise.try(() => {
        return actualDomain || sayHello(win, { send }).then(({ domain }) => domain);

    }).then(normalizedDomain => {
        if (!matchDomain(targetDomain, targetDomain)) {
            throw new Error(`Domain ${ stringify(targetDomain) } does not match ${ stringify(targetDomain) }`);
        }

        return normalizedDomain;
    });
}

export const send : SendType = (win, name, data, options) => {
    options = options || {};
    let domain = options.domain || WILDCARD;
    const responseTimeout = options.timeout || RES_TIMEOUT;
    const childTimeout = options.timeout || CHILD_WINDOW_TIMEOUT;
    const fireAndForget = options.fireAndForget || false;

    // $FlowFixMe
    return ZalgoPromise.try(() => {
        validateOptions(name, win, domain);

        if (isAncestor(window, win)) {
            return awaitWindowHello(win, childTimeout);
        }
        
    }).then(({ domain: actualDomain } = {}) => {

        return normalizeDomain(win, domain, actualDomain, { send });
    }).then(targetDomain => {

        domain = targetDomain;

        const logName = (name === MESSAGE_NAME.METHOD && data && typeof data.name === 'string') ? `${ data.name }()` : name;

        if (__DEBUG__) {
            console.info('send::req', logName, domain, '\n\n', data); // eslint-disable-line no-console
        }

        const promise = new ZalgoPromise();
        const hash = `${ name }_${ uniqueID() }`;

        if (!fireAndForget) {
            const responseListener : ResponseListenerType = { name, win, domain, promise };
            addResponseListener(hash, responseListener);

            const reqPromises = windowStore('requestPromises').getOrSet(win, () => []);
            reqPromises.push(promise);

            promise.catch(() => {
                markResponseListenerErrored(hash);
                deleteResponseListener(hash);
            });

            const totalAckTimeout = isWindowKnown(win) ? ACK_TIMEOUT_KNOWN : ACK_TIMEOUT;
            const totalResTimeout = responseTimeout;

            let ackTimeout = totalAckTimeout;
            let resTimeout = totalResTimeout;
        
            const interval = safeInterval(() => {
                if (isWindowClosed(win)) {
                    return promise.reject(new Error(`Window closed for ${ name } before ${ responseListener.ack ? 'response' : 'ack' }`));
                }

                if (responseListener.cancelled) {
                    return promise.reject(new Error(`Response listener was cancelled for ${ name }`));
                }

                ackTimeout = Math.max(ackTimeout - RESPONSE_CYCLE_TIME, 0);
                if (resTimeout !== -1) {
                    resTimeout = Math.max(resTimeout - RESPONSE_CYCLE_TIME, 0);
                }

                if (!responseListener.ack && ackTimeout === 0) {
                    return promise.reject(new Error(`No ack for postMessage ${ logName } in ${ getDomain() } in ${ totalAckTimeout }ms`));

                } else if (resTimeout === 0) {
                    return promise.reject(new Error(`No response for postMessage ${ logName } in ${ getDomain() } in ${ totalResTimeout }ms`));
                }
            }, RESPONSE_CYCLE_TIME);

            promise.finally(() => {
                interval.cancel();
                reqPromises.splice(reqPromises.indexOf(promise, 1));
            }).catch(noop);
        }

        try {
            sendMessage(win, domain, {
                type: MESSAGE_TYPE.REQUEST,
                hash,
                name,
                data,
                fireAndForget
            }, { on, send });
        } catch (err) {
            throw new Error(`Send request message failed for ${ logName } in ${ getDomain() }\n\n${ stringifyError(err) }`);
        }
    
        return fireAndForget ? promise.resolve() : promise;
    });
};
