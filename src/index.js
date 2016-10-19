'use strict';

var Geocoder = require('leaflet-control-geocoder');
var LRM = require('leaflet-routing-machine');
var mapseedSidebar = require("mapseed-sidebar/js/leaflet-sidebar");
var itineraryBuilder = require('./itinerary_builder');
var locate = require('leaflet.locatecontrol');
var options = require('./lrm_options');
var links = require('./links');
var leafletOptions = require('./leaflet_options');
var ls = require('local-storage');
var tools = require('./tools');
var state = require('./state');
var localization = require('./localization');

var parsedOptions = links.parse(window.location.search.slice(1));

var mergedOptions = L.extend(leafletOptions.defaultState, parsedOptions);
var local = localization.get(mergedOptions.language);

var mapLayer = leafletOptions.layer;
var overlay = leafletOptions.overlay;
var baselayer = ls.get('layer') ? mapLayer[0][ls.get('layer')] : mapLayer[0]['Mapbox Streets'];
var layers = ls.get('getOverlay') && [baselayer, overlay['Small Components']] || baselayer;
var map = L.map('map', {
  zoomControl: true,
  dragging: true,
  layers: layers,
  maxZoom: 18
}).setView(mergedOptions.center, mergedOptions.zoom);

// Pass basemap layers
mapLayer = mapLayer.reduce(function(title, layer) {
  title[layer.label] = L.tileLayer(layer.tileLayer, {
    id: layer.label
  });
  return title;
});


/* Leaflet Controls */
L.control.layers(mapLayer, overlay, {
  position: 'bottomleft'
}).addTo(map);

L.control.scale().addTo(map);

/* Store User preferences */
// store baselayer changes
map.on('baselayerchange', function(e) {
  ls.set('layer', e.name);
});
// store overlay add or remove
map.on('overlayadd', function(e) {
  ls.set('getOverlay', true);
});
map.on('overlayremove', function(e) {
  ls.set('getOverlay', false);
});

/* OSRM setup */
var ReversablePlan = L.Routing.Plan.extend({
  createGeocoders: function() {
    var container = L.Routing.Plan.prototype.createGeocoders.call(this);
    return container;
  }
});

/* Setup markers */
function makeIcon(i, n) {
  var chargerIcon = 'images/marker-charger-icon-2x.png';
  var markerList = ['images/marker-start-icon-2x.png', 'images/marker-end-icon-2x.png'];
  if (i === 0) {
    return L.icon({
      iconUrl: markerList[0],
      iconSize: [20, 56],
      iconAnchor: [10, 28]
    });
  }
  if (i === n - 1) {
    return L.icon({
      iconUrl: markerList[1],
      iconSize: [20, 56],
      iconAnchor: [10, 28]
    });
  } else {
    return L.icon({
      iconUrl: chargerIcon,
      iconSize: [25, 70],
      iconAnchor: [10, 36],
      popupAnchor: [2, -36]
    });
  }
}

//setup charging popup
var chargingPopup = function(charging_step) {
  var chargingDurationInMinutes = (charging_step.charging_duration / 60.0);
  var content = "<ul class='list-group'>";
  content += "<li class='list-group-item active'>" + charging_step.name + "</li>";
  content += "<li class='list-group-item'>Énergie: <span class='badge'>" + charging_step.energy.toFixed(1) + " kWh</span></li>";
  content += "<li class='list-group-item'>Durée: <span class='badge'>" + chargingDurationInMinutes.toFixed(0) + " min</span></li>";
  content += "<li class='list-group-item'>Coût: <span class='badge'>" + charging_step.charging_cost.toFixed(2) + " $</span></li>";
  content += "</ul>";
  console.log(content);
  return content;
};

var plan = new ReversablePlan([], {
  geocoder: Geocoder.nominatim(),
  routeWhileDragging: true,
  createMarker: function(i, wp, n) {
    // Do not enable dragging for chargers
    var enableDraggable = (i === 0 || i === (n - 1)) && this.draggableWaypoints;
    var options = {
      draggable: enableDraggable,
      icon: makeIcon(i, n)
    };
    var marker = L.marker(wp.latLng, options);

    if (i > 0 && i < (n - 1)) {
      marker.bindPopup(wp.popupContent);
      marker.on('click', function(e) {
        this.openPopup();
      });
    }

    return marker;
  },
  routeDragInterval: options.lrm.routeDragInterval,
  addWaypoints: false,
  waypointMode: 'snap',
  position: 'topright',
  useZoomParameter: options.lrm.useZoomParameter,
  reverseWaypoints: false,
  dragStyles: options.lrm.dragStyles,
  geocodersClassName: options.lrm.geocodersClassName,
  geocoderPlaceholder: function(i, n) {
    var startend = [local['Start - press enter to drop marker'], local['End - press enter to drop marker']];
    var via = [local['Via point - press enter to drop marker']];
    if (i === 0) {
      return startend[0];
    }
    if (i === (n - 1)) {
      return startend[1];
    } else {
      return via;
    }
  }
});

// add marker labels
var lrmControl = L.Routing.control({
  plan: plan,
  routeWhileDragging: options.lrm.routeWhileDragging,
  lineOptions: options.lrm.lineOptions,
  altLineOptions: options.lrm.altLineOptions,
  summaryTemplate: options.lrm.summaryTemplate,
  containerClassName: options.lrm.containerClassName,
  alternativeClassName: options.lrm.alternativeClassName,
  stepClassName: options.lrm.stepClassName,
  language: mergedOptions.language,
  showAlternatives: options.lrm.showAlternatives,
  units: mergedOptions.units,
  serviceUrl: leafletOptions.services[0].path,
  useZoomParameter: options.lrm.useZoomParameter,
  routeDragInterval: options.lrm.routeDragInterval
}).addTo(map);
var toolsControl = tools.control(localization.get(mergedOptions.language), localization.getLanguages(), options.tools).addTo(map);
var state = state(map, lrmControl, toolsControl, mergedOptions);

plan.on('waypointgeocoded', function(e) {
  if (plan._waypoints.filter(function(wp) { return !!wp.latLng; }).length < 2) {
    map.panTo(e.waypoint.latLng);
  }
});

var makeWaypoint = function(lat, lon) {
  return L.Routing.waypoint(L.latLng(lat, lon));
}

var sendEvnavRequest = function(evnavUrl, callback) {
  //evnavUrl = 'http://localhost:8080/route/v1/evnav/-73.57225,45.53847;-71.28751,46.79206?battery=18&SOC_act=0.8'
  $.ajax({
    url: evnavUrl,
    dataType: 'json',
    success: callback,
    error: function(req, status, error) {
      console.log(error);
    }
  })
}

var waypointLocToString = function(wp) {
  return wp.latLng.lng + "," + wp.latLng.lat;
}

plan.on('waypointdragend', function(e) {
  var wps = plan.getWaypoints();
  if (wps.length < 2)
      return;
  var src = wps[0];
  var dst = wps[wps.length - 1];
  var queryUrl = "http://localhost:8080/route/v1/evnav/" +
      waypointLocToString(src) + ";" + waypointLocToString(dst) + "?" +
      "battery=21&" +
      "SOC_act=1.0&" +
      "SOC_min=0.1&" +
      "SOC_max=0.8&" +
      "efficiency=0.190&" +
      "power_avg=33.0";
  console.log("queryUrl:" + queryUrl);
  sendEvnavRequest(queryUrl, function(data) {
    if (data.code === "Ok") {
      var wps = plan.getWaypoints();
      if (data.message === "reachable") {
        lrmControl.options.lineOptions.styles[0].color = '#022bb1';
        var steps = data.charging_steps;
        var newWps = [wps[0]];
        for (var i = 0; i < steps.length; i++) {
          var lon = steps[i]["location"][0];
          var lat = steps[i]["location"][1];
          var chargerWP = makeWaypoint(lat, lon);
          chargerWP.popupContent = chargingPopup(steps[i]);
          chargerWP.is_charger = true;
          newWps.push(chargerWP);
        }
        newWps.push(wps[wps.length - 1]);
        plan.setWaypoints(newWps);

      } else {
        // unreachable with an electric car
        lrmControl.options.lineOptions.styles[0].color = '#b10214';
        plan.setWaypoints([wps[0], wps[wps.length - 1]]);
      }
    }
  });
});

// add onClick event
map.on('click', addWaypoint);
function addWaypoint(e) {
  var length = lrmControl.getWaypoints().filter(function(pnt) {
    return pnt.latLng;
  });
  length = length.length;
  if (!length) {
    lrmControl.spliceWaypoints(0, 1, e.latlng);
  } else {
    if (length === 1) length = length + 1;
    lrmControl.spliceWaypoints(length - 1, 1, e.latlng);
  }
}

// User selected routes
lrmControl.on('alternateChosen', function(e) {
  var directions = document.querySelectorAll('.leaflet-routing-alt');
  if (directions[0].style.display != 'none') {
    directions[0].style.display = 'none';
    directions[1].style.display = 'block';
  } else {
    directions[0].style.display = 'block';
    directions[1].style.display = 'none';
  }
});

L.control.locate({
  follow: false,
  setView: true,
  remainActive: false,
  keepCurrentZoomLevel: true,
  stopFollowingOnDrag: false,
  onLocationError: function(err) {
    alert(err.message)
  },
  onLocationOutsideMapBounds: function(context) {
    alert(context.options.strings.outsideMapBoundsMsg);
  },
  showPopup: false,
  locateOptions: {}
}).addTo(map);
