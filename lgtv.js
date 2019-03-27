let arp = require('arp')
let SsdpClient = require('node-ssdp').Client
let lgClientFactory = require('lgtv2')
let wol = require('node-wol')

class AssistantLgTv {

  constructor(configuration, plugins) {
    this._plugins = plugins;
    this._ip = configuration.ip
    this._mac = configuration.mac
  }

  action(line) {
    let [cmd, ...args] = line.split(" ")

    switch(cmd) {
      case "power":
        return args[0] === "on" ? this.powerOn() : this.powerOff()

      case "toast":
        return this.toast(args.join(" "))

      case "input":
        return setInput(args[0])

      case "launch":
        this.powerOn()
        return this.request("ssap://system.launcher/launch", {id:args[0]})

      case "open":
        this.powerOn()
        return this.request("ssap://system.launcher/open", {url:args.join(" ")})

      case "volumeUp":
        this.volumeUp(args[0])
        return Promise.resolve()

      case "volumeDown":
        this.volumeDown(args[0])
        return Promise.resolve()

      case "request":
      case "requestw":
        let [service, ...pl] = args
        let payload
        if (pl.length > 0) {
          payload = JSON.parse(pl.join(" "))
        }

        this.powerOn()
        let r = this.request(service, payload)
        return cmd === "requestw" ? r : Promise.resolve()

      default:
        console.log("[assistant-lgtv] Commande inconnue: ", args)
        return Promise.resolve()
    }
  }

  powerOn() {
    if (this._mac) {
      wol.wake(this._mac, {}, () => {})
    }
    return Promise.resolve()
  }

  powerOff() {
    this.request("ssap://system/turnOff")
    return Promise.resolve()
  }

  setInput(input) {
    this.powerOn()
    this.request("ssap://tv/switchInput", {inputId:input})
    return Promise.resolve()
  }

  toast(message) {
    this.request("ssap://system.notifications/createToast", {message})
    return Promise.resolve()
  }

  volumeUp(count) {
    return this.repeatRequest("ssap://audio/volumeUp", count)
  }

  volumeDown(count) {
    return this.repeatRequest("ssap://audio/volumeDown", count)
  }

  repeatRequest(service, count) {
    let r = count ? parseInt(count) || 1 : 1

    let e = Promise.resolve()
    while (r-- > 0) {
      e = e.then(() =>
        this.request(service)
          .then(() => new Promise(ok => setTimeout(() => ok(), 1000))))
    }
    return e
  }

  request(service, payload) {
    return this._getClient().then(c => {
      return new Promise(ok => c.request(service, payload, function(err, res) {
          if (err) {
            console.log("[assistant-lgtv] Error:", err)
          }
          ok()
        }))
      })
  }

  _getClient() {
    if (!this.client) {

      console.log("[assistant-lgtv] Creating a new connection to the tv")

      let conf = {url:"ws://" + this._ip + ":3000"}
      let lgtv = lgClientFactory(conf)

      this.client = new Promise((ok, cerr) => {

        var timeout = setTimeout(() => {
          cerr("Timeout")
        }, 10000)

        lgtv.on('error', err => {
          console.log("[assistant-lgtv] Error:", err)
        })

        lgtv.on('connect', () => {
          console.log("[assistant-lgtv] Connected")
          conf.reconnect = false
          clearTimeout(timeout)
          ok(lgtv)
        })

        lgtv.on('close', () => {
          clearTimeout(timeout)
          cerr("closed")
        })

      }).catch(err => {
        this.client = null
        console.log("[assistant-lgtv] Error:", err)
        lgtv.disconnect()
        return Promise.reject(err)
      })
    }

    return this.client;
  }

  _scanNetwork() {
    if (this._ip && !this._mac) {
      return this._resolveMACAddress().then(e => this)
    } else if (!this._ip) {
      
      return new Promise((ok, err) => {
        let ssdpClient = new SsdpClient()

        let timeout = setTimeout(() => {
          ssdpClient.stop()
          err("[assistant-lgtv] LG TV not found")
        }, 5000)

        ssdpClient.on('response', (headers, statusCode, rinfo) => {

          if (headers.SERVER && headers.SERVER.indexOf("LGE WebOS TV") >= 0) {
            console.log("[assistant-lgtv] Found Device " + headers.SERVER + " on " + rinfo.address)
            this._ip = rinfo.address
            ssdpClient.stop()
            clearTimeout(timeout)

            this._resolveMACAddress().then(r => ok(this))
          }
        })

        ssdpClient.search("urn:schemas-upnp-org:device:MediaRenderer:1")

      })
    } else {
      return Promise.resolve(this)
    }
  }

  _resolveMACAddress() {
    return new Promise(ok => {
      arp.getMAC(this._ip, (err, mac) => {
        if (!err && mac.indexOf(':') > 0) {
          this._mac = mac.split(":").map(x => x.length === 1 ? "0" + x : x).join(":")
          console.log("[assistant-lgtv] IP " + this._ip + " resolved to " + this._mac)
        } else {
          console.log("[assistant-lgtv] No mac address found for " + this._ip + ". power on will not works")
        }

        this._plugins.assistant.saveConfig("lgtv", {
          ip:this._ip,
          mac:this._mac
        })

        ok()
      })
    })
  }
}

exports.init = function(configuration, plugins) {
  return new AssistantLgTv(configuration, plugins)._scanNetwork().then(p => {
    console.log("[assistant-lgtv] Plugin chargé");
    return p
  })
}
