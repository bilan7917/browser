import { CipherType } from '../enums/cipherType.enum';

import BrowserApi from '../browser/browserApi';

import MainBackground from './main.background';

import AutofillService from '../services/autofill.service';
import CipherService from '../services/cipher.service';
import UtilsService from '../services/utils.service';

export default class RuntimeBackground {
    private runtime: any;
    private autofillTimeout: number;
    private pageDetailsToAutoFill: any[] = [];

    constructor(private main: MainBackground, private autofillService: AutofillService,
        private cipherService: CipherService) {
        this.runtime = chrome.runtime;
    }

    async init() {
        if (!this.runtime) {
            return;
        }

        if (this.runtime.onInstalled) {
            this.runtime.onInstalled.addListener((details: any) => {
                (window as any).ga('send', {
                    hitType: 'event',
                    eventAction: 'onInstalled ' + details.reason,
                });

                if (details.reason === 'install') {
                    chrome.tabs.create({ url: 'https://bitwarden.com/browser-start/' });
                }
            });
        }

        this.runtime.onMessage.addListener(async (msg: any, sender: any, sendResponse: any) => {
            switch (msg.command) {
                case 'loggedIn':
                case 'unlocked':
                case 'locked':
                    await this.main.setIcon();
                    await this.main.refreshBadgeAndMenu();
                    break;
                case 'logout':
                    await this.main.logout(msg.expired);
                    break;
                case 'syncCompleted':
                    if (msg.successfully) {
                        setTimeout(async () => await this.main.refreshBadgeAndMenu(), 2000);
                    }
                    break;
                case 'bgOpenNotificationBar':
                    await BrowserApi.tabSendMessage(sender.tab, 'openNotificationBar', msg.data);
                    break;
                case 'bgCloseNotificationBar':
                    await BrowserApi.tabSendMessage(sender.tab, 'closeNotificationBar');
                    break;
                case 'bgAdjustNotificationBar':
                    await BrowserApi.tabSendMessage(sender.tab, 'adjustNotificationBar', msg.data);
                    break;
                case 'bgCollectPageDetails':
                    this.main.collectPageDetailsForContentScript(sender.tab, msg.sender, sender.frameId);
                    break;
                case 'bgAddLogin':
                    await this.addLogin(msg.login, sender.tab);
                    break;
                case 'bgAddClose':
                    this.removeAddLogin(sender.tab);
                    break;
                case 'bgAddSave':
                    await this.saveAddLogin(sender.tab);
                    break;
                case 'bgNeverSave':
                    await this.saveNever(sender.tab);
                    break;
                case 'bgUpdateContextMenu':
                    await this.main.refreshBadgeAndMenu();
                    break;
                case 'collectPageDetailsResponse':
                    switch (msg.sender) {
                        case 'notificationBar':
                            const forms = this.autofillService.getFormsWithPasswordFields(msg.details);
                            await BrowserApi.tabSendMessage(msg.tab, 'notificationBarPageDetails', {
                                details: msg.details,
                                forms: forms,
                            });
                            break;
                        case 'autofiller':
                        case 'autofill_cmd':
                            await this.autofillService.doAutoFillForLastUsedLogin([{
                                frameId: sender.frameId,
                                tab: msg.tab,
                                details: msg.details,
                            }], msg.sender === 'autofill_cmd');
                            break;
                        case 'contextMenu':
                            clearTimeout(this.autofillTimeout);
                            this.pageDetailsToAutoFill.push({
                                frameId: sender.frameId,
                                tab: msg.tab,
                                details: msg.details,
                            });
                            this.autofillTimeout = setTimeout(async () => await this.autofillPage(), 300);
                            break;
                        default:
                            break;
                    }
                    break;
                default:
                    break;
            }
        });
    }

    private async autofillPage() {
        await this.autofillService.doAutoFill({
            cipher: this.main.loginToAutoFill,
            pageDetails: this.pageDetailsToAutoFill,
            fromBackground: true,
        });

        // reset
        this.main.loginToAutoFill = null;
        this.pageDetailsToAutoFill = [];
    }

    private async saveAddLogin(tab: any) {
        for (let i = this.main.loginsToAdd.length - 1; i >= 0; i--) {
            if (this.main.loginsToAdd[i].tabId !== tab.id) {
                continue;
            }

            const loginInfo = this.main.loginsToAdd[i];
            const tabDomain = UtilsService.getDomain(tab.url);
            if (tabDomain != null && tabDomain !== loginInfo.domain) {
                continue;
            }

            this.main.loginsToAdd.splice(i, 1);

            const cipher = await this.cipherService.encrypt({
                id: null,
                folderId: null,
                favorite: false,
                name: loginInfo.name,
                notes: null,
                type: CipherType.Login,
                login: {
                    uri: loginInfo.uri,
                    username: loginInfo.username,
                    password: loginInfo.password,
                },
            });

            await this.cipherService.saveWithServer(cipher);
            (window as any).ga('send', {
                hitType: 'event',
                eventAction: 'Added Login from Notification Bar',
            });

            BrowserApi.tabSendMessage(tab, 'closeNotificationBar');
        }
    }

    private async saveNever(tab: any) {
        for (let i = this.main.loginsToAdd.length - 1; i >= 0; i--) {
            if (this.main.loginsToAdd[i].tabId !== tab.id) {
                continue;
            }

            const loginInfo = this.main.loginsToAdd[i];
            const tabDomain = UtilsService.getDomain(tab.url);
            if (tabDomain != null && tabDomain !== loginInfo.domain) {
                continue;
            }

            this.main.loginsToAdd.splice(i, 1);
            const hostname = UtilsService.getHostname(tab.url);
            await this.cipherService.saveNeverDomain(hostname);
            BrowserApi.tabSendMessage(tab, 'closeNotificationBar');
        }
    }

    private async addLogin(loginInfo: any, tab: any) {
        const loginDomain = UtilsService.getDomain(loginInfo.url);
        if (loginDomain == null) {
            return;
        }

        const ciphers = await this.cipherService.getAllDecryptedForDomain(loginDomain);

        let match = false;
        for (let i = 0; i < ciphers.length; i++) {
            if (ciphers[i].login.username === loginInfo.username) {
                match = true;
                break;
            }
        }

        if (!match) {
            // remove any old logins for this tab
            this.removeAddLogin(tab);

            this.main.loginsToAdd.push({
                username: loginInfo.username,
                password: loginInfo.password,
                name: loginDomain,
                domain: loginDomain,
                uri: loginInfo.url,
                tabId: tab.id,
                expires: new Date((new Date()).getTime() + 30 * 60000), // 30 minutes
            });

            await this.main.checkLoginsToAdd(tab);
        }
    }

    private removeAddLogin(tab: any) {
        for (let i = this.main.loginsToAdd.length - 1; i >= 0; i--) {
            if (this.main.loginsToAdd[i].tabId === tab.id) {
                this.main.loginsToAdd.splice(i, 1);
            }
        }
    }

    private async currentTabSendMessage(command: string, data: any = null) {
        const tab = await BrowserApi.getTabFromCurrentWindow();
        if (tab == null) {
            return;
        }

        await BrowserApi.tabSendMessage(tab, command, data);
    }
}
