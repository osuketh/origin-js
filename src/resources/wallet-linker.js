import ZeroClientProvider from 'web3-provider-engine/zero'
import uuidv1 from 'uuid/v1';

const appendSlash = (url) => {
  return (url.substr(-1) === "/") ? url : url + "/"
}


class WalletLinker {
  constructor({linkerServerUrl, fetch, networkChangeCb, web3}) {
    this.serverUrl = linkerServerUrl
    this.fetch = fetch
    this.accounts = []
    this.networkChangeCb = networkChangeCb
    this.callbacks = {}
    this.placeholder_on = false
    this.PLACEHOLDER_ADDRESS = '0xAF298D050e4395d69670B12B7F41000000000000'
    this.session_token = ""
    this.web3 = web3
    this.loadSessionStorage()
    this.showPopUp = null // define callback here to display popUp
    this.setLinkCode = null // define callback here to setLinkCode
  }

  logout() {
      sessionStorage.setItem("walletLinkerData", JSON.stringify({
        accounts:[],
        session_token:""
      }))
      this.loadSessionStorage()
      clearInterval(self.interval)
  }

  startPlaceholder(){
    this.placeholder_on = true
    return this.PLACEHOLDER_ADDRESS
  }

  endPlaceholder() {
    this.placeholder_on = false
  }

  async startLink() {
    let code = await this.generateLinkCode()
    this.setLinkCode(code)
    this.showPopUp(true)
  }

  cancelLink() {
    this.pending_call = undefined
    this.showPopUp(false)
  }

  loadSessionStorage() {
    let wallet_data_str = sessionStorage.getItem("walletLinkerData");
    let wallet_data = undefined
    try{
       wallet_data = JSON.parse(wallet_data_str)
    }catch(err){
    }

    if (wallet_data)
    {
      this.accounts = wallet_data.accounts
      this.networkRpcUrl = wallet_data.networkRpcUrl,
      this.session_token = wallet_data.session_token,
      this.last_message_id = wallet_data.last_message_id
      this.linked = wallet_data.linked
    }
  }


  syncSessionStorage() {
      let wallet_data = {
        accounts:this.accounts,
        networkRpcUrl:this.networkRpcUrl,
        linked:this.linked,
        last_message_id:this.last_message_id,
        session_token:this.session_token,
        linked:this.linked
      }
      sessionStorage.setItem("walletLinkerData", JSON.stringify(wallet_data))
  }


  getProvider() {
    let provider = ZeroClientProvider({
      rpcUrl:this.networkRpcUrl && this.linked ? this.networkRpcUrl : this.web3.currentProvider.host,
      getAccounts: this.getAccounts.bind(this),
      //signTransaction: this.signTransaction.bind(this)

      processTransaction: this.processTransaction.bind(this)
    })
    let hookedWallet = provider._providers[6]

    if (!hookedWallet.validateTransaction)
    {
      console.log("The sub provider at [6] is NOT a hooked wallet.")
    }
    else
    {
      //we basically make validate a passthrough for now
      hookedWallet.validateTransaction = (txParams, cb) => {cb()}
    }
    return provider
  }

  getAccounts(callback) {
    if (callback){
      callback(undefined, this.accounts)
    }
    else
    {
      return new Promise((resolve, reject) => {
        resolve(this.accounts)
      })
    }
  }

  signTransaction(txn_object, callback) {
    let call_id = uuidv1()
    //txn_object["chainId"] = this.web3.utils.toHex(this.netId)
    txn_object["gasLimit"] = txn_object["gas"]
    let result = this.post("call-wallet", {session_token:this.session_token, call_id:call_id, accounts:this.accounts, call:["signTransaction",{txn_object}], return_url:this.getReturnUrl()})

    this.callbacks[call_id] = (data) => {
      callback(undefined, data)
    }

    result.then((data) => {
    }).catch((error_data) => {
      delete this.callbacks[call_id]
      callback(error_data, undefined);
    });
  }

  processTransaction(txn_object, callback) {
    let call_id = uuidv1()
    //translate gas to gasLimit
    txn_object["gasLimit"] = txn_object["gas"]
    if (this.placeholder_on)
    {
      if (txn_object["from"].toLowerCase() == this.PLACEHOLDER_ADDRESS.toLowerCase())
      {
        txn_object["from"] = undefined
      }
    }

    this.callbacks[call_id] = (data) => {
      callback(undefined, data.hash)
    }

    if (!this.linked)
    {
      this.pending_call = {call_id, session_token: this.session_token, call:["processTransaction",{txn_object}]}
      this.startLink()
    }
    else
    {
      let result = this.post("call-wallet", {session_token:this.session_token, call_id:call_id, accounts:this.accounts, call:["processTransaction",{txn_object}], return_url:this.getReturnUrl()})

    
      result.then((data) => {
      }).catch((error_data) => {
        delete this.callbacks[call_id]
        callback(error_data, undefined);
      });
    }
  }


  async changeNetwork(networkRpcUrl, force=false) {
    if (this.networkRpcUrl != networkRpcUrl || force)
    {
      this.networkRpcUrl = networkRpcUrl
      this.networkChangeCb()
      //this.netId = await this.web3.eth.net.getId()
    }
  }

  processMessages(messages) {
    for(let message of messages) {
      switch(message.type)
      {
        case "ACCOUNTS":
          this.accounts = message.accounts
          break;
        case "NETWORK":
          this.changeNetwork(message.network_rpc)
          break;
        case "CALL_RESPONSE":
          if (this.callbacks[message.call_id])
          {
            this.callbacks[message.call_id](message.result)
            delete this.callbacks[message.call_id]
          }
          else
          {
            if (message.result && message.result.purchase)
            {
                alert("Purchase successful.")
            }
          }
          break;
        case "LOGOUT":
          if(this.linked)
          {
            this.logout()
          }
          break;
      }
      if (message.id != undefined)
      {
        this.last_message_id = message.id
      }
      this.syncSessionStorage()
    }
  }

  startMessagesSync() {
    if(!this.interval) 
    {
      //5 second intervals for now
      this.interval = setInterval(this.syncLinkMessages.bind(this), 5*1000)
    }
  }

  getReturnUrl() {
    if ((typeof window.orientation !== "undefined") || (navigator.userAgent.indexOf('IEMobile') !== -1))
    {
        return window.location.href
    }
    else
    {
        return ""
    }
  }

  initSession() {
    if (this.linked && this.networkRpcUrl)
    {
      this.changeNetwork(this.networkRpcUrl, true)
    }
    else
    {
      //set the network to us..
      this.networkChangeCb()
    }
    this.syncLinkMessages()
  }

  async generateLinkCode() {
    let ret = await this.post("generate-code", {session_token:this.session_token, return_url:this.getReturnUrl(), pending_call:this.pending_call})
    if (ret)
    {
      this.session_token = ret.session_token
      this.link_code = ret.link_code
      this.linked = ret.linked
      this.syncSessionStorage()
      this.startMessagesSync()
      return ret.link_code
    }
  }

  getLinkCode(){
    return this.link_code
  }

  async syncLinkMessages() {
    let ret = await this.post("link-messages", {session_token:this.session_token, last_message_id:this.last_message_id})
    if (ret.session_token)
    {
      this.session_token = ret.session_token

      if (!ret.linked && this.linked)
      {
        this.logout()
      }
      else
      {
        this.linked = ret.linked
      }

      if (this.linked)
      {
        this.cancelLink()
      }
      this.startMessagesSync()
      if (ret.messages && ret.messages.length)
      {
        this.processMessages(ret.messages)
      }
    }
    else
    {
      if (this.linked && ret.session_token == null)
      {
        //logout of this
        this.logout()
      }
    }
  }

  async http(baseUrl, url, body, method) {
    let response = await this.fetch(
      appendSlash(baseUrl) + url,
      {
        method,
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined,
        headers: { "content-type": "application/json" },
      }
    )
    let json = await response.json()
    if (response.ok) {
      return json
    }
    return Promise.reject(JSON.stringify(json))
  }

  async post(url, body) {
    return this.http(this.serverUrl, url, body, 'POST')
  }

  async get(url) {
    return this.http(this.serverUrl, url, undefined, 'GET')
  }
}

module.exports = WalletLinker
